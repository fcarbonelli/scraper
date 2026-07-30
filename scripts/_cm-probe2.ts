/** TEMP: find how masonline exposes per-sucursal stock (IS API + simulation). */
const BASE = 'https://www.masonline.com.ar';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// 229975 = OOS by default (seller 1). 162599 = in stock by default.
const OOS = '229975';

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'es-AR,es;q=0.9' } });
  const txt = await res.text();
  try { return { status: res.status, body: JSON.parse(txt) }; } catch { return { status: res.status, body: txt.slice(0, 200) }; }
}
async function postJson(url: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const txt = await res.text();
  try { return { status: res.status, body: JSON.parse(txt) }; } catch { return { status: res.status, body: txt.slice(0, 200) }; }
}

async function main(): Promise<void> {
  // Region + sellers for CABA.
  const { body: regBody } = await getJson(`${BASE}/api/checkout/pub/regions?country=ARG&postalCode=1414`);
  const region = Array.isArray(regBody) ? regBody[0] : regBody;
  const regionId: string = region?.id;
  const regionSellers: string[] = (region?.sellers ?? []).map((s: any) => s.id);
  console.log(`regionId=${regionId}\nregionSellers=${regionSellers.join(',')}\n`);

  // Need the SKU id for the OOS product.
  const cat = await getJson(`${BASE}/api/catalog_system/pub/products/search?fq=productId:${OOS}`);
  const sku = cat.body?.[0]?.items?.[0]?.itemId;
  console.log(`OOS product ${OOS} sku=${sku}\n`);

  // --- Approach A: Intelligent Search variants -----------------------------
  const isUrls = [
    `${BASE}/api/io/_v/api/intelligent-search/product_search/?query=&fq=product.id:${OOS}&count=1`,
    `${BASE}/api/io/_v/api/intelligent-search/product_search/?query=&fq=product.id:${OOS}&count=1&regionId=${encodeURIComponent(regionId)}&hideUnavailableItems=false`,
    `${BASE}/api/io/_v/api/intelligent-search/product_search/?query=${OOS}&count=1&regionId=${encodeURIComponent(regionId)}`,
  ];
  for (const u of isUrls) {
    const r = await getJson(u);
    const prods = r.body?.products ?? r.body?.data?.products ?? [];
    const sellers = prods?.[0]?.items?.[0]?.sellers;
    console.log(`IS [${r.status}] recordsFiltered=${r.body?.recordsFiltered ?? '?'} products=${prods?.length ?? 0} ` +
      (sellers ? JSON.stringify(sellers.map((s: any) => ({ id: s.sellerId, av: s.commertialOffer?.IsAvailable, q: s.commertialOffer?.AvailableQuantity, p: s.commertialOffer?.Price }))) : (typeof r.body === 'string' ? r.body : 'no-sellers')));
    console.log(`   url=${u.replace(BASE, '')}`);
  }

  // --- Approach B: checkout simulation against each region seller ----------
  console.log('');
  if (sku) {
    for (const seller of ['1', ...regionSellers.slice(0, 6)]) {
      const r = await postJson(`${BASE}/api/checkout/pub/orderForms/simulation?sc=1`, {
        items: [{ id: sku, quantity: 1, seller }],
        country: 'ARG',
        postalCode: '1414',
      });
      const it = r.body?.items?.[0];
      console.log(`SIM seller=${seller} [${r.status}] availability=${it?.availability ?? '(no item)'} price=${it?.price != null ? it.price / 100 : '-'}`);
    }
  }
}
void main().catch((e) => { console.error('ERR', e); process.exitCode = 1; });
