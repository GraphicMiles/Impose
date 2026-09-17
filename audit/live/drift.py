"""Prove the client-side counts.remix += 1 is a real drift source:
remix a post while OFFLINE, so no server refetch can mask it."""
from playwright.sync_api import sync_playwright
SIGNIN="""async(em)=>{
  const c=window.supabase.createClient(window.BotoConfig.SUPABASE_URL, window.BotoConfig.SUPABASE_ANON_KEY);
  await c.auth.signInWithPassword({email:em,password:'Aud1t!Pass123'});
  window.BotoData.forgetUser();}"""
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844})
    pg=ctx.new_page()
    pg.add_init_script("try{localStorage.setItem('impose.onboarded.v1','1')}catch(e){}")
    pg.goto("http://127.0.0.1:8000/index.html#/", wait_until="networkidle"); pg.wait_for_timeout(2500)
    pg.evaluate(SIGNIN,"alice.audit@mailinator.com"); pg.wait_for_timeout(500)
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(3000)
    # seed one post so there is something to remix
    pg.evaluate("""async()=>{await window.BotoData.createGeneration(window.BotoData.newKey(),
      {prompt:'drift base',response:'x'});}""")
    pg.wait_for_timeout(1500)
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(3000)
    cid=pg.evaluate("()=>{const c=document.querySelector('#cmFeedList .gen');return c&&c.dataset.id}")
    before=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);return c.querySelector('[data-act=remix] .act-cnt').textContent.trim()}",cid)
    srv=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.data.items.find(x=>x.id===id);return row.counts.remix;}""",cid)
    print("before: ui=%s server=%s"%(before,srv))
    # go offline so the write queues and nothing refetches
    pg.route("**/rest/v1/rpc/create_generation", lambda r: r.abort())
    pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);c.querySelector('[data-act=remix]').click()}",cid)
    pg.wait_for_timeout(600)
    pg.fill("#cmInput","offline remix"); pg.click("#cmSendBtn"); pg.wait_for_timeout(2500)
    after=pg.evaluate("(id)=>{const c=[...document.querySelectorAll('#cmFeedList .gen')].find(e=>e.dataset.id===id);const e=c&&c.querySelector('[data-act=remix] .act-cnt');return e?e.textContent.trim():'card gone'}",cid)
    srv2=pg.evaluate("""async(id)=>{const r=await window.BotoData.feedPage(null);
      const row=r.data.items.find(x=>x.id===id);return row.counts.remix;}""",cid)
    print("after queued-but-unsent remix: ui=%s server=%s"%(after,srv2))
    if after!=str(srv2):
        print("  >> DRIFT CONFIRMED: the card claims a remix the database does not have")
    else:
        print("  >> no drift")
    b.close()
