"""Section 7 + 8: adversarial interaction and database consistency."""
import json, urllib.request, urllib.error, threading, uuid
U="https://xgqcvuzkeaferjsnpjjw.supabase.co"
import os
K=os.environ.get("SUPABASE_ANON_KEY","")  # export before running
P=F=0
issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s FAIL %s"%(sev,m)); issues.append((sev,m))

def call(path, tok=None, method="GET", body=None):
    h={"apikey":K,"Content-Type":"application/json"}
    if tok: h["Authorization"]="Bearer "+tok
    r=urllib.request.Request(U+path, data=json.dumps(body).encode() if body else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(r,timeout=25) as resp:
            t=resp.read().decode(); return resp.status,(json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t=e.read().decode()
        try: return e.code,json.loads(t)
        except: return e.code,t

def signin(e):
    s,d=call("/auth/v1/token?grant_type=password",method="POST",body={"email":e,"password":"Aud1t!Pass123"})
    return d["access_token"], d["user"]["id"]
alice,aid=signin("alice.audit@mailinator.com")
bob,bid=signin("bob.audit@mailinator.com")

print("DOUBLE TAP / RAPID FIRE")
key=str(uuid.uuid4())
res=[]
def post():
    s,d=call("/rest/v1/rpc/create_generation",alice,"POST",
             {"p_key":key,"p_prompt":"double tap","p_response":"x"})
    res.append((s,d))
ts=[threading.Thread(target=post) for _ in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
s,rows=call("/rest/v1/generations?prompt=eq.double%20tap&select=id",alice)
ok(len(rows)==1, "8 concurrent identical submits create 1 row, got %d"%len(rows), "P0")
ids={ (d[0] if isinstance(d,list) else d).get("id") for st,d in res if st<400 and d }
ok(len(ids)<=1, "and every response names the same row")
gid=rows[0]["id"]

print("\nSAVE: double tap, and the counter")
for _ in range(5):
    call("/rest/v1/saves",alice,"POST",{"user_id":aid,"generation_id":gid})
s,cnt=call("/rest/v1/generations?id=eq.%s&select=save_count"%gid,alice)
ok(cnt[0]["save_count"]==1, "saving 5 times counts once, got %s"%cnt[0]["save_count"], "P1")
call("/rest/v1/saves?user_id=eq.%s&generation_id=eq.%s"%(aid,gid),alice,"DELETE")
s,cnt=call("/rest/v1/generations?id=eq.%s&select=save_count"%gid,alice)
ok(cnt[0]["save_count"]==0, "unsave reverses it, got %s"%cnt[0]["save_count"], "P1")

print("\nCOUNTERS ARE DERIVED, NOT DRIFTING")
ckeys=[str(uuid.uuid4()) for _ in range(4)]
cids=[]
for k in ckeys:
    s,d=call("/rest/v1/rpc/create_comment",alice,"POST",{"p_key":k,"p_gen":gid,"p_body":"c "+k[:4]})
    if s<400: cids.append((d[0] if isinstance(d,list) else d)["id"])
s,cnt=call("/rest/v1/generations?id=eq.%s&select=comment_count"%gid,alice)
ok(cnt[0]["comment_count"]==4, "4 comments -> count 4, got %s"%cnt[0]["comment_count"], "P1")
call("/rest/v1/rpc/soft_delete_comment",alice,"POST",{"p_id":cids[0]})
s,cnt=call("/rest/v1/generations?id=eq.%s&select=comment_count"%gid,alice)
ok(cnt[0]["comment_count"]==3, "soft delete decrements, got %s"%cnt[0]["comment_count"], "P1")
s,thread=call("/rest/v1/rpc/thread_for",alice,"POST",{"p_gen":gid})
live=[c for c in thread if not c["deleted_at"]]
ok(len(live)==cnt[0]["comment_count"], "count matches what a reader can actually see (%d vs %s)"%(len(live),cnt[0]["comment_count"]), "P1")

print("\nDELETED PARENT: replies must survive (no broken thread)")
s,d=call("/rest/v1/rpc/create_comment",alice,"POST",{"p_key":str(uuid.uuid4()),"p_gen":gid,"p_body":"parent"})
pid=(d[0] if isinstance(d,list) else d)["id"]
s,d=call("/rest/v1/rpc/create_comment",bob,"POST",{"p_key":str(uuid.uuid4()),"p_gen":gid,"p_body":"bob reply","p_parent":pid})
rid=(d[0] if isinstance(d,list) else d)["id"] if s<400 else None
ok(rid is not None, "another user can reply (HTTP %s)"%s, "P1")
call("/rest/v1/rpc/soft_delete_comment",alice,"POST",{"p_id":pid})
s,thread=call("/rest/v1/rpc/thread_for",alice,"POST",{"p_gen":gid})
survivor=[c for c in thread if c["id"]==rid]
ok(survivor and survivor[0]["parent_id"]==pid,
   "the reply survives with its parent link intact (cascade would have eaten it)", "P0")
tomb=[c for c in thread if c["id"]==pid]
ok(tomb and tomb[0]["deleted_at"] and tomb[0]["body"]=="",
   "the parent is a tombstone: row kept, body actually gone", "P1")

print("\nREPLY TO A DELETED PARENT IS REFUSED")
s,d=call("/rest/v1/rpc/create_comment",bob,"POST",
         {"p_key":str(uuid.uuid4()),"p_gen":gid,"p_body":"orphan","p_parent":pid})
ok(s>=400 and "parent_gone" in str(d), "refused with parent_gone (HTTP %s)"%s, "P1")

print("\nPAGINATION UNDER CONCURRENT WRITES")
for i in range(14):
    call("/rest/v1/rpc/create_generation",alice,"POST",
         {"p_key":str(uuid.uuid4()),"p_prompt":"page %02d"%i,"p_response":"x"})
seen=[]; cur=None
for _ in range(6):
    body={"p_limit":10}
    if cur: body["p_before_time"]=cur[0]; body["p_before_id"]=cur[1]
    s,rows=call("/rest/v1/rpc/feed_page",alice,"POST",body)
    if not rows: break
    # a write lands mid-scroll
    call("/rest/v1/rpc/create_generation",bob,"POST",
         {"p_key":str(uuid.uuid4()),"p_prompt":"interleaved","p_response":"x"})
    seen += [r["id"] for r in rows]
    if len(rows)<10: break
    cur=(rows[-1]["created_at"], rows[-1]["id"])
ok(len(seen)==len(set(seen)), "no duplicate rows while the feed is written to (%d/%d)"%(len(set(seen)),len(seen)), "P1")

print(f"\n{P} passed, {F} failed")
if issues:
    print("\nISSUES:")
    for sev,m in issues: print("  %s: %s"%(sev,m))
