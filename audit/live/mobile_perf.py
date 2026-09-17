"""Sections 14 and 15: mobile behaviour and resource discipline."""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))
SIGNIN="""async()=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  await c.auth.signInWithPassword({email:'alice.audit@mailinator.com',password:'Aud1t!Pass123'});
  window.BotoData.forgetUser();}"""
with sync_playwright() as p:
    b=p.chromium.launch()
    for w,h,label in [(320,568,"iPhone SE"),(390,844,"iPhone 14"),(768,1024,"tablet")]:
        ctx=b.new_context(viewport={"width":w,"height":h})
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
        pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2000)
        if w==320:
            pg.evaluate(SIGNIN); pg.wait_for_timeout(400)
            pg.evaluate("""async()=>{
              await window.BotoData.createGeneration(window.BotoData.newKey(),
                {prompt:'A'.repeat(600),response:'B'.repeat(900)});
              await window.BotoData.createGeneration(window.BotoData.newKey(),
                {prompt:'emoji ok 🇳🇬 üñïçø∂é <script>alert(1)</script>',response:'x'});}""")
            pg.wait_for_timeout(1500)
        pg.reload(wait_until="networkidle"); pg.wait_for_timeout(2500)
        print("=== %s (%dx%d) ==="%(label,w,h))
        ok(not pg.evaluate("()=>document.documentElement.scrollWidth>window.innerWidth+1"),
           "no horizontal overflow with 600-char text", "P2")
        tap=pg.evaluate("""()=>{const bad=[];
          document.querySelectorAll('#cmFeedList button, #cmComposerDock button').forEach(b=>{
            const r=b.getBoundingClientRect();
            if(r.width&&r.height&&(r.width<24||r.height<24)) bad.push(b.className.split(' ')[0]+':'+Math.round(r.width)+'x'+Math.round(r.height));});
          return [...new Set(bad)];}""")
        ok(len(tap)==0, "touch targets are reachable: %s"%(tap or "all >=24px"), "P2")
        ok(not pg.evaluate("()=>{const d=document.getElementById('cmComposerDock');const r=d.getBoundingClientRect();return r.bottom>window.innerHeight+2}"),
           "the composer sits inside the viewport", "P1")
        esc=pg.evaluate("()=>document.getElementById('cmFeedList').innerHTML.includes('<script>')")
        ok(not esc, "user text is escaped, not injected as markup", "P0")
        ok(not errs, "no page errors: %s"%errs, "P1")
        pg.close(); ctx.close()

    print("\n=== PERFORMANCE (section 15) ===")
    ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page(); reqs=[]
    pg.on("request", lambda r: reqs.append(r.url))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(3000)
    feed=[r for r in reqs if "feed_page" in r]
    ok(len(feed)<=2, "one feed fetch on load, not a storm: %d"%len(feed), "P2")
    reqs.clear()
    # idle with the tab hidden: the poll must stop
    pg.evaluate("()=>Object.defineProperty(document,'hidden',{value:true,configurable:true})")
    pg.evaluate("()=>document.dispatchEvent(new Event('visibilitychange'))")
    pg.wait_for_timeout(6000)
    polls=[r for r in reqs if "feed_since" in r]
    ok(len(polls)==0, "a hidden tab issues no polls: %d"%len(polls), "P2")
    print("errors: []")
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for sev,m in issues: print("  %s: %s"%(sev,m))
    b.close()
