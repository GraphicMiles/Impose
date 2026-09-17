"""Sections 5, 10, 11, 12: UI truthfulness and complete journeys."""
from playwright.sync_api import sync_playwright
P=F=0; issues=[]
def ok(c,m,sev="P2"):
    global P,F
    if c: P+=1; print("  PASS "+m)
    else:
        F+=1; print("  ** %s %s"%(sev,m)); issues.append((sev,m))

SIGNIN="""async(em)=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  const r=await c.auth.signInWithPassword({email:em,password:'Aud1t!Pass123'});
  window.BotoData.forgetUser(); return !r.error;}"""

with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2500)
    pg.evaluate(SIGNIN,"alice.audit@mailinator.com"); pg.wait_for_timeout(500)
    # seed our own fixture: a suite that depends on leftover rows is testing
    # the previous run, not the product
    pg.evaluate("""async()=>{await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'audit base post',response:'body text'});}""")
    pg.wait_for_timeout(1500)
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(3000)

    print("SECTION 12: does the UI tell the truth about counts?")
    card=pg.evaluate("""()=>{const c=document.querySelector('#cmFeedList .gen');
      if(!c) return null;
      const n=x=>{const e=c.querySelector('[data-act='+x+'] .act-cnt');return e?e.textContent.trim():null};
      return {id:c.dataset.id, comment:n('discuss'), save:n('save'), remix:n('remix')};}""")
    ok(card is not None, "the feed rendered at least one card", "P0")
    srv=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.ok&&r.data.items.find(x=>x.id===id);
      return row?{comment:row.counts.comment,save:row.counts.save,remix:row.counts.remix}:null;}""", card["id"])
    ok(card["comment"]==str(srv["comment"]), "comment count on the card matches the server (%s vs %s)"%(card["comment"],srv["comment"]), "P1")
    ok(card["save"]==str(srv["save"]), "save count matches (%s vs %s)"%(card["save"],srv["save"]), "P1")

    print("\nSECTION 5: SAVE -> consequence -> persistence")
    pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);c.querySelector('[data-act=save]').click()}", card["id"])
    pg.wait_for_timeout(2000)
    after=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const e=c.querySelector('[data-act=save] .act-cnt');return e.textContent.trim()}", card["id"])
    ok(after==str(srv["save"]+1), "the count moves immediately (%s)"%after)
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(3000)
    persisted=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.ok&&r.data.items.find(x=>x.id===id); return row?{n:row.counts.save,mine:row.saved}:null;}""", card["id"])
    ok(persisted and persisted["n"]==srv["save"]+1, "and survives a refresh (%s)"%(persisted and persisted["n"]), "P1")
    ok(persisted and persisted["mine"] is True, "the icon knows it is mine after reload", "P1")

    print("\nDOUBLE TAP SAVE IN THE UI")
    pg.evaluate("""(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);
      const b=c.querySelector('[data-act=save]'); b.click(); b.click(); b.click();}""", card["id"])
    pg.wait_for_timeout(2500)
    fin=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.ok&&r.data.items.find(x=>x.id===id); return row?{n:row.counts.save,mine:row.saved}:null;}""", card["id"])
    ui=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);return c.querySelector('[data-act=save]').getAttribute('aria-pressed')}", card["id"])
    ok(str(fin["mine"]).lower()==ui, "after rapid taps the icon matches the database (ui=%s db=%s)"%(ui,fin["mine"]), "P1")
    ok(fin["n"] in (0,1), "and the count is not corrupted: %s"%fin["n"], "P1")

    print("\nSECTION 11: REMIX journey end to end")
    pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const b=c.querySelector('[data-act=remix]'); if(b)b.click()}", card["id"])
    pg.wait_for_timeout(800)
    ok(pg.is_visible("#cmRemixCtx"), "remix opens the composer with context", "P1")
    before=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const e=c.querySelector('[data-act=remix] .act-cnt');return e.textContent.trim()}", card["id"])
    pg.fill("#cmInput","a remix of that"); pg.click("#cmSendBtn"); pg.wait_for_timeout(3500)
    srv2=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.ok&&r.data.items.find(x=>x.id===id);
      const kid=r.ok&&r.data.items.find(x=>x.prompt==='a remix of that');
      return {parentRemix:row&&row.counts.remix, kidKind:kid&&kid.kind, kidParent:kid&&kid.parentId};}""", card["id"])
    ok(srv2["kidKind"]=="remix", "the child is stored as a remix, got %s"%srv2["kidKind"], "P1")
    ok(srv2["kidParent"]==card["id"], "and points at its parent", "P1")
    ok(srv2["parentRemix"]==1, "the parent's remix count is derived by the server: %s"%srv2["parentRemix"], "P1")
    uiCount=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const e=c&&c.querySelector('[data-act=remix] .act-cnt');return e?e.textContent.trim():null}", card["id"])
    ok(uiCount==str(srv2["parentRemix"]), "and the card shows that number, not a locally invented one (ui=%s db=%s)"%(uiCount,srv2["parentRemix"]), "P1")
    print("errors:", errs)
    print(f"\n{P} passed, {F} failed")
    if issues:
        print("\nISSUES:")
        for sev,m in issues: print("  %s: %s"%(sev,m))
    b.close()
