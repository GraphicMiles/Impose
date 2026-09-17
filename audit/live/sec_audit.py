"""Section 9: test what users must NOT be able to do.
Direct API calls, bypassing the frontend entirely."""
import json, urllib.request, urllib.error
U="https://xgqcvuzkeaferjsnpjjw.supabase.co"
import os
K=os.environ.get("SUPABASE_ANON_KEY","")  # export before running
P=F=0
def ok(c,m):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else: F+=1; print("  ** P0 FAIL "+m)

def call(path, tok=None, method="GET", body=None, prefer=None):
    h={"apikey":K,"Content-Type":"application/json"}
    if tok: h["Authorization"]="Bearer "+tok
    if prefer: h["Prefer"]=prefer
    r=urllib.request.Request(U+path, data=json.dumps(body).encode() if body else None,
                             headers=h, method=method)
    try:
        with urllib.request.urlopen(r,timeout=20) as resp:
            t=resp.read().decode()
            return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t=e.read().decode()
        try: return e.code, json.loads(t)
        except: return e.code, t

def signin(email):
    s,d=call("/auth/v1/token?grant_type=password",method="POST",
             body={"email":email,"password":"Aud1t!Pass123"})
    return d.get("access_token"), d.get("user",{}).get("id")

alice, aid = signin("alice.audit@mailinator.com")
bob, bid   = signin("bob.audit@mailinator.com")
print("alice:",aid[:8],"bob:",bid[:8])

# alice posts
s,d = call("/rest/v1/rpc/create_generation", alice, "POST",
           {"p_key":"11111111-1111-1111-1111-111111111111","p_prompt":"alice post","p_response":"body"})
gid = (d[0] if isinstance(d,list) else d)["id"]
s,d = call("/rest/v1/rpc/create_comment", alice, "POST",
           {"p_key":"22222222-2222-2222-2222-222222222222","p_gen":gid,"p_body":"alice comment"})
cid = (d[0] if isinstance(d,list) else d)["id"]

print("\nSECTION 9: what Bob must NOT be able to do")
s,_ = call("/rest/v1/generations?id=eq."+gid, bob, "PATCH", {"prompt":"HIJACKED"})
s2,chk = call("/rest/v1/generations?id=eq."+gid+"&select=prompt", bob)
ok(chk and chk[0]["prompt"]=="alice post", "cannot edit another user's post (HTTP %s)"%s)

s,_ = call("/rest/v1/generations?id=eq."+gid, bob, "PATCH", {"deleted_at":"2020-01-01T00:00:00Z"})
s2,chk = call("/rest/v1/generations?id=eq."+gid+"&select=deleted_at", bob)
ok(chk and chk[0]["deleted_at"] is None, "cannot delete another user's post (HTTP %s)"%s)

s,_ = call("/rest/v1/generations?id=eq."+gid, bob, "PATCH", {"locked":True})
s2,chk = call("/rest/v1/generations?id=eq."+gid+"&select=locked", bob)
ok(chk and chk[0]["locked"] is False, "cannot lock another user's post (HTTP %s)"%s)

s,d = call("/rest/v1/rpc/soft_delete_comment", bob, "POST", {"p_id":cid})
s2,chk = call("/rest/v1/comments?id=eq."+cid+"&select=deleted_at", bob)
ok(chk and chk[0]["deleted_at"] is None, "cannot delete another user's comment (HTTP %s)"%s)

# forge authorship
s,d = call("/rest/v1/rpc/create_generation", bob, "POST",
           {"p_key":"33333333-3333-3333-3333-333333333333","p_prompt":"forged","p_response":"x"})
row = (d[0] if isinstance(d,list) else d) if s<400 else None
ok(not row or row["author_id"]==bid, "a post is always authored by the caller")

s,_ = call("/rest/v1/saves", bob, "POST", {"user_id":aid,"generation_id":gid})
ok(s>=400, "cannot save on another user's behalf (HTTP %s)"%s)

print("\nUNAUTHENTICATED (anon key only)")
s,_ = call("/rest/v1/rpc/create_generation", None, "POST",
           {"p_key":"44444444-4444-4444-4444-444444444444","p_prompt":"anon","p_response":"x"})
ok(s>=400, "anonymous cannot post (HTTP %s)"%s)
s,_ = call("/rest/v1/generations?id=eq."+gid, None, "PATCH", {"prompt":"anon edit"})
s2,chk = call("/rest/v1/generations?id=eq."+gid+"&select=prompt", bob)
ok(chk and chk[0]["prompt"]=="alice post", "anonymous cannot edit (HTTP %s)"%s)

print("\nSECRET TABLES stay unreachable")
for t in ["auth_codes","auth_tickets","rate_counters","workspace_grants","waitlist"]:
    s,_ = call("/rest/v1/"+t+"?select=*&limit=1", bob)
    ok(s>=400, "%s unreadable by a signed-in user (HTTP %s)"%(t,s))

print("\nPRIVATE POSTS")
s,d = call("/rest/v1/rpc/create_generation", alice, "POST",
           {"p_key":"55555555-5555-5555-5555-555555555555","p_prompt":"alice secret",
            "p_response":"x","p_visibility":"private"})
pid=(d[0] if isinstance(d,list) else d)["id"]
s,chk = call("/rest/v1/generations?id=eq."+pid+"&select=prompt", bob)
ok(chk==[], "a private post is invisible to others")
s,chk = call("/rest/v1/rpc/feed_page", bob, "POST", {"p_limit":50})
ok(not any(x["prompt"]=="alice secret" for x in (chk or [])), "and absent from their feed")
s,d = call("/rest/v1/rpc/create_comment", bob, "POST",
           {"p_key":"66666666-6666-6666-6666-666666666666","p_gen":pid,"p_body":"peek"})
ok(s>=400, "cannot comment on a post they cannot see (HTTP %s)"%s)

print(f"\n{P} passed, {F} failed")
