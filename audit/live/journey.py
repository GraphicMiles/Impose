"""Sections 10, 11, 19, 20: complete journeys and dead ends."""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))
SIGNIN="""async(em)=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  await c.auth.signInWithPassword({email:em,password:'Aud1t!Pass123'});
  window.BotoData.forgetUser();}"""
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2500)
    pg.evaluate(SIGNIN,"alice.audit@mailinator.com"); pg.wait_for_timeout(500)
    gid=pg.evaluate("""async()=>{const r=await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'journey post',response:'body'}); return r.ok?r.data.id:null;}""")
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(3000)

    print("SECTION 11: post -> thread -> reply -> back")
    pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);c.querySelector('[data-act=discuss]').click()}",gid)
    pg.wait_for_timeout(1500)
    ok(pg.is_visible("#cmDetailView"), "the comment button opens the thread", "P1")
    ok(not pg.is_visible("#cmCommentCtx"), "and does not aim the composer at anyone", "P1")
    ok(pg.evaluate("()=>!!document.querySelector('[data-first-reply]')"), "an empty thread offers a Reply, not a dead end", "P1")

    pg.evaluate("()=>document.querySelector('[data-first-reply]').click()"); pg.wait_for_timeout(500)
    ok(pg.is_visible("#cmCommentInput"), "the CTA opens the composer")
    pg.fill("#cmCommentInput","first comment"); pg.click("#cmCommentSend"); pg.wait_for_timeout(3000)
    st=pg.evaluate("""async(g)=>{const t=await window.BotoData.thread(g);
      return t.ok?t.data.map(c=>({id:c.id,t:c.text,p:c.parentId})):[];}""",gid)
    ok(len(st)==1 and st[0]["p"] is None, "the first comment is top level, not a reply")
    ok(pg.evaluate("()=>document.querySelectorAll('.trow').length")==1, "and it is on screen")

    print("\nREPLY TO THAT COMMENT")
    pg.evaluate("()=>{const r=document.querySelector('.trow [data-reply]'); if(r)r.click()}")
    pg.wait_for_timeout(500)
    ok(pg.is_visible("#cmCommentCtx"), "replying names who is being answered", "P1")
    pg.fill("#cmCommentInput","a reply"); pg.click("#cmCommentSend"); pg.wait_for_timeout(3000)
    st2=pg.evaluate("""async(g)=>{const t=await window.BotoData.thread(g);
      return t.ok?t.data.map(c=>({t:c.text,p:c.parentId})):[];}""",gid)
    rep=[c for c in st2 if c["t"]=="a reply"]
    ok(rep and rep[0]["p"]==st[0]["id"], "the reply attaches to the right parent in the database", "P1")

    print("\nCOUNT TRUTH (section 12)")
    cnt=pg.evaluate("""async(g)=>{const r=await window.BotoData.feedPage(null);
      const row=r.data.items.find(x=>x.id===g); return row&&row.counts.comment;}""",gid)
    ok(cnt==2, "server count is 2, got %s"%cnt, "P1")
    pg.evaluate("()=>{location.hash='#/'}"); pg.wait_for_timeout(2000)
    ui=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const e=c&&c.querySelector('[data-act=discuss] .act-cnt');return e?e.textContent.trim():null}",gid)
    ok(ui==str(cnt), "the feed card agrees (ui=%s db=%s)"%(ui,cnt), "P1")

    print("\nSECTION 10: deep link + back navigation")
    pg.goto("http://127.0.0.1:8000/index.html#/g/"+gid, wait_until="networkidle"); pg.wait_for_timeout(3000)
    ok(pg.is_visible("#cmDetailView"), "a deep link opens the thread directly", "P1")
    # One of the two is a nested reply, which renders collapsed by design
    # (Task 9): assert the data arrived, not a row count that depends on
    # how many chains happen to be open.
    got=pg.evaluate("""async(g)=>{const t=await window.BotoData.thread(g);
      return {server:t.ok?t.data.length:0,
              onscreen:document.querySelectorAll('.trow').length,
              text:document.querySelector('#cmDetail').innerText};}""", gid)
    ok(got["server"]==2 and got["onscreen"]>=1 and "first comment" in got["text"],
       "its thread loads from the server (%d server, %d visible rows)"%(got["server"],got["onscreen"]), "P1")
    pg.go_back(); pg.wait_for_timeout(2000)
    ok(pg.is_visible("#cmFeedView"), "browser back returns to the feed", "P1")

    print("\nINVALID DEEP LINK (must not be a dead end)")
    pg.goto("http://127.0.0.1:8000/index.html#/g/00000000-0000-0000-0000-000000000000", wait_until="networkidle")
    pg.wait_for_timeout(3000)
    txt=pg.inner_text("#cmDetail") if pg.is_visible("#cmDetailView") else pg.inner_text("#cmMain")
    ok(len(txt.strip())>0, "a missing post explains itself rather than showing nothing", "P1")
    ok(pg.evaluate("()=>!!document.querySelector('#cmDetail a, #cmDetail button, .gen-missing')") or "not" in txt.lower() or "gone" in txt.lower(),
       "and offers a way out: %r"%txt.strip()[:70], "P1")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for sev,m in issues: print("  %s: %s"%(sev,m))
    b.close()
