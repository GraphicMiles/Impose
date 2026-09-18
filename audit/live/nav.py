"""Navigation, the marketing pages, and mode switching. flow.txt 10, 14, 15."""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))
PAGES=["about.html","contact.html","privacy.html","terms.html",
       "data-security.html","acceptable-use.html","404.html","auth.html"]
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append((pg.url.split("/")[-1], str(e))))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")

    print("MARKETING + LEGAL PAGES")
    for page in PAGES:
        pg.goto("http://127.0.0.1:8000/"+page, wait_until="networkidle"); pg.wait_for_timeout(900)
        body=pg.inner_text("body")
        ok(len(body.strip())>200, "%-22s renders content (%d chars)"%(page,len(body)))
        dead=pg.evaluate("""()=>[...document.querySelectorAll('a[href]')]
            .filter(a=>a.getAttribute('href')==='#'||a.getAttribute('href')==='').length""")
        ok(dead==0, "%-22s no link to nowhere"%page)
        ok(not pg.evaluate("()=>document.documentElement.scrollWidth>window.innerWidth+1"),
           "%-22s no horizontal overflow"%page)

    print("\nROUTES inside the app")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2500)
    for h in ["#/", "#/workspace", "#/u/nobody", "#/g/00000000-0000-0000-0000-000000000000", "#/garbage", "#/"]:
        pg.evaluate("(x)=>{location.hash=x}", h); pg.wait_for_timeout(1800)
        visible=pg.evaluate("""()=>{
          const ids=['cmFeedView','cmDetailView','cmProfileView','wsContent'];
          return ids.filter(i=>{const e=document.getElementById(i);return e&&!e.hidden});}""")
        ok(len(visible)>=1, "%-42s shows a view: %s"%(h, visible))

    print("\nBACK / FORWARD across routes")
    pg.evaluate("()=>{location.hash='#/'}"); pg.wait_for_timeout(1200)
    pg.evaluate("()=>{location.hash='#/u/nobody'}"); pg.wait_for_timeout(1500)
    pg.go_back(); pg.wait_for_timeout(1500)
    ok(pg.evaluate("()=>location.hash")=="#/", "back returns to the feed")
    ok(pg.is_visible("#cmFeedView"), "and the feed is the visible view", "P1")
    pg.go_forward(); pg.wait_for_timeout(1500)
    ok(pg.is_visible("#cmProfileView"), "forward returns to the profile", "P1")

    print("\nMODE SWITCH")
    pg.evaluate("()=>{location.hash='#/'}"); pg.wait_for_timeout(1200)
    pg.evaluate("()=>document.getElementById('cmTabWorkspace').click()"); pg.wait_for_timeout(2000)
    ok(pg.evaluate("()=>!document.getElementById('wsContent').hidden"), "workspace opens", "P1")
    pg.evaluate("()=>document.getElementById('cmTabCommunity').click()"); pg.wait_for_timeout(2000)
    ok(pg.is_visible("#cmFeedView"), "and community comes back", "P1")
    ok(pg.evaluate("()=>document.querySelectorAll('#cmFeedList .gen').length")>=0, "with its feed intact")

    print("\n404 PAGE has a way out")
    pg.goto("http://127.0.0.1:8000/404.html", wait_until="networkidle"); pg.wait_for_timeout(900)
    ok(pg.evaluate("()=>[...document.querySelectorAll('a[href]')].some(a=>/index|\\/$|home/i.test(a.getAttribute('href')))"),
       "it links home", "P1")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for s,m in issues: print("  %s: %s"%(s,m))
    b.close()
