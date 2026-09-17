"""The real deep-link case: a browser that has never seen the post."""
from playwright.sync_api import sync_playwright
P=F=0
def ok(c,m,sev="P1"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else: F+=1; print("  ** %s %s"%(sev,m))
SIGNIN="""async(em)=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  await c.auth.signInWithPassword({email:em,password:'Aud1t!Pass123'});
  window.BotoData.forgetUser();}"""
with sync_playwright() as p:
    b=p.chromium.launch()
    # author's browser
    a=b.new_context(viewport={"width":390,"height":844}).new_page()
    a.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    a.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); a.wait_for_timeout(2500)
    a.evaluate(SIGNIN,"alice.audit@mailinator.com"); a.wait_for_timeout(500)
    gid=a.evaluate("""async()=>{const r=await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'shared post',response:'the body'});
      if(!r.ok) return null;
      await window.BotoData.createComment(window.BotoData.newKey(), r.data.id, 'a comment on it', null);
      return r.data.id;}""")
    print("author created:", gid[:8])

    # a completely fresh browser, as if the link were shared
    fresh=b.new_context(viewport={"width":390,"height":844})
    pg=fresh.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/g/"+gid, wait_until="networkidle")
    pg.wait_for_timeout(4000)
    body=pg.inner_text("#cmDetail")
    ok("does not exist" not in body, "a real post is not reported as missing")
    ok("shared post" in body, "the post body renders from the server")
    ok(pg.evaluate("()=>document.querySelectorAll('.trow').length")==1,
       "and its comments load: %d rows"%pg.evaluate("()=>document.querySelectorAll('.trow').length"))
    ok("a comment on it" in body, "the comment text is there")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    b.close()
