// TEMP: deactivate the last no-EAN mapping (Lysoform 285cc, Maxi Consumo). Delete after.
import { db } from '../src/shared/db.js';

const id = 'c0966348-f3b6-429c-bd83-7c2d42466dd5'; // LYSOFORM DESINFECTANTE ORIGINAL 285 CC
const { data, error } = await db
  .from('supermarket_products')
  .update({ is_active: false })
  .eq('id', id)
  .eq('is_active', true)
  .select('id, is_active');
if (error) { console.error(error.message); process.exit(1); }
console.log((data ?? []).length ? `✓ ${id}: deactivated` : `- ${id}: already inactive / not found`);
process.exit(0);
