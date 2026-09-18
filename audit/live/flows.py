"""The Community flows I had never driven end to end."""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))
SIGNIN="""async(em)=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  await c.auth.signInWithPassword({email:em,password:'Fl0w!Test123'});
  window.BotoData.forgetUser();}"""
with sync_playwright() as p:
    b=p.chromium.launch()
    A=b.new_context(viewport={"width":390,"height":844}).new_page()
    B=b.new_context(viewport={"width":390,"height":844}).new_page()
    errs=[]
    for pg,em in ((A,"t1.flow@qa-impose.dev"),(B,"t2.flow@qa-impose.dev")):
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
        pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2200)
        pg.evaluate(SIGNIN, em); pg.wait_for_timeout(500)
    A.reload(wait_until="networkidle"); B.reload(wait_until="networkidle")
    A.wait_for_timeout(2500); B.wait_for_timeout(2500)

    gid=A.evaluate("""async()=>{const r=await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'flow base post',response:'body'}); return r.ok?r.data.id:null;}""")
    A.wait_for_timeout(1500); A.reload(wait_until="networkidle"); A.wait_for_timeout(2500)

    print("SAVE / UNSAVE round trip")
    A.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);c.querySelector('[data-act=save]').click()}", gid)
    A.wait_for_timeout(2500)
    A.reload(wait_until="networkidle"); A.wait_for_timeout(2500)
    st=A.evaluate("""async(g)=>{const r=await window.BotoData.feedPage(null);
      const row=r.data.items.find(x=>x.id===g); return {saved:row.saved,n:row.counts.save};}""", gid)
    ok(st["saved"] and st["n"]==1, "save survives a reload: %s"%st, "P1")
    pressed=A.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);return c.querySelector('[data-act=save]').getAttribute('aria-pressed')}", gid)
    ok(pressed=="true", "and the icon shows it after reload", "P1")
    A.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);c.querySelector('[data-act=save]').click()}", gid)
    A.wait_for_timeout(2500)
    st2=A.evaluate("""async(g)=>{const r=await window.BotoData.feedPage(null);
      const row=r.data.items.find(x=>x.id===g); return {saved:row.saved,n:row.counts.save};}""", gid)
    ok(not st2["saved"] and st2["n"]==0, "unsave reverses it: %s"%st2, "P1")

    print("\nLOCK: the author locks, another user cannot remix")
    A.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const b=c.querySelector('[data-act=lock]'); if(b)b.click()}", gid)
    A.wait_for_timeout(2500)
    locked=A.evaluate("""async(g)=>{const r=await window.BotoData.generation(g);return r.ok&&r.data.locked;}""", gid)
    ok(locked, "the lock persisted to the server", "P1")
    denied=B.evaluate("""async(g)=>{const r=await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'steal',response:'x',kind:'remix',remixOf:g}); return {ok:r.ok,err:r.error||''};}""", gid)
    ok(not denied["ok"], "another user cannot remix a locked post: %s"%denied["err"][:40], "P0")

    print("\nPRIVATE POST end to end")
    pid=A.evaluate("""async()=>{const r=await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'my private note',response:'secret',visibility:'private'}); return r.ok?r.data.id:null;}""")
    ok(pid is not None, "a private post can be created")
    mine=A.evaluate("""async()=>{const r=await window.BotoData.feedPage(null);
      return r.data.items.some(x=>x.prompt==='my private note');}""")
    ok(mine, "the author sees it in their own feed", "P1")
    theirs=B.evaluate("""async()=>{const r=await window.BotoData.feedPage(null);
      return r.data.items.some(x=>x.prompt==='my private note');}""")
    ok(not theirs, "nobody else does", "P0")
    B.evaluate("(id)=>{location.hash='#/g/'+id}", pid); B.wait_for_timeout(3000)
    ok("does not exist" in B.inner_text("#cmDetail"),
       "and a direct link to it is refused, not rendered", "P0")

    print("\nDELETE A POST, then undo")
    A.evaluate("()=>{location.hash='#/'}"); A.wait_for_timeout(2000)
    A.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const k=c.querySelector('[data-act=menu]'); if(k)k.click()}", gid)
    A.wait_for_timeout(700)
    A.evaluate("()=>{const d=document.querySelector('.comment-menu [data-mact=delete]'); if(d)d.click()}")
    A.wait_for_timeout(2500)
    gone=A.evaluate("""async(g)=>{const r=await window.BotoData.feedPage(null);
      return !r.data.items.some(x=>x.id===g);}""", gid)
    ok(gone, "the post leaves the feed", "P1")
    srv=A.evaluate("""async(g)=>{const r=await window.BotoData.generation(g);return r.ok&&r.data&&r.data.deleted;}""", gid)
    ok(srv is True, "and is soft deleted on the server, not removed", "P1")
    undo=A.evaluate("()=>{const t=[...document.querySelectorAll('.toast button, .toast [role=button]')].find(b=>/undo/i.test(b.textContent)); if(t){t.click();return true} return false}")
    A.wait_for_timeout(2500)
    if undo:
        back=A.evaluate("""async(g)=>{const r=await window.BotoData.generation(g);return r.ok&&r.data&&!r.data.deleted;}""", gid)
        ok(back, "undo restores it on the server", "P1")
    else:
        ok(False, "an undo affordance was offered", "P1")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for s,m in issues: print("  %s: %s"%(s,m))
    b.close()
