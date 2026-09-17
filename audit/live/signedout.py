"""Section 4 + 9: the signed-out journey. A visitor can read; what happens
when they try to write?"""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P1"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))
with sync_playwright() as p:
    b=p.chromium.launch()
    # author seeds one post
    a=b.new_context(viewport={"width":390,"height":844}).new_page()
    a.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    a.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); a.wait_for_timeout(2000)
    a.evaluate("""async()=>{
      const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
      await c.auth.signInWithPassword({email:'alice.audit@mailinator.com',password:'Aud1t!Pass123'});
      window.BotoData.forgetUser();
      await window.BotoData.createGeneration(window.BotoData.newKey(),{prompt:'public read me',response:'x'});}""")
    a.wait_for_timeout(1500)

    ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(3000)

    print("SIGNED OUT: read")
    ok("public read me" in pg.inner_text("#cmFeedList"), "a visitor can read the feed")
    print("\nSIGNED OUT: attempt to write")
    pg.fill("#cmInput","i am not signed in"); pg.click("#cmSendBtn"); pg.wait_for_timeout(3500)
    srv=pg.evaluate("""async()=>{const r=await window.BotoData.feedPage(null);
      return r.ok?r.data.items.map(x=>x.prompt):[];}""")
    ok("i am not signed in" not in srv, "the post does not reach the database", "P0")
    toast=pg.evaluate("""()=>{const t=document.querySelector('.toast');return t?t.textContent:''}""")
    card=pg.evaluate("""()=>{const c=[...document.querySelectorAll('#cmFeedList .gen')]
      .find(e=>e.innerText.includes('i am not signed in'));
      return c?{failed:!!c.querySelector('.gen-failed'),pending:!!c.querySelector('.gen-pending'),
                text:(c.querySelector('.gen-failed')||{}).innerText||''}:null;}""")
    told = ("sign in" in toast.lower()) or (card and card["failed"] and "sign in" in card["text"].lower())
    ok(told, "and the user is told to sign in rather than left guessing (toast=%r card=%s)"%(toast[:60],card), "P1")
    stuck = card and card["pending"] and not card["failed"]
    ok(not stuck, "the card is not left stuck on Sending forever", "P1")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for sev,m in issues: print("  %s: %s"%(sev,m))
    b.close()
