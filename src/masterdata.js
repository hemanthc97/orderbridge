// Synthetic master data. Every partner, item, price and location here is invented for the demo.
import { round2 } from './util.js';

const ITEMS = [
  ['DP-2200', 'Trail daypack 22 L', 6, 48.0, true],
  ['DP-3500', 'Trail pack 35 L', 4, 79.0, true],
  ['BT-0750', 'Insulated bottle 750 ml', 12, 14.5, true],
  ['BT-1000', 'Insulated bottle 1 L', 12, 17.25, true],
  ['HL-0300', 'Headlamp 300 lm', 24, 21.0, true],
  ['TW-0240', 'Travel towel large', 20, 9.8, true],
  ['SB-0005', 'Sleeping bag 5 C', 4, 64.0, true],
  ['TN-0002', 'Two-person tent', 2, 149.0, true],
  ['ST-0001', 'Camp stove single burner', 6, 38.5, true],
  ['CK-0004', 'Cook set four-piece', 8, 27.0, true],
  ['GL-0100', 'Trekking gloves', 24, 12.4, true],
  ['LN-0100', 'Lantern 100 lm', 12, 19.0, false], // discontinued: still cross-referenced, no longer orderable
  ['RC-0020', 'Rain cover 20-35 L', 30, 7.6, true], // new item: partners order it before the cross-reference exists
];

// Each partner identifies our items with its own numbering scheme.
const partNumber = {
  KESTREL: (i) => `KOC-${10000 + i * 37}`,
  MARLOWE: (i) => String(400100 + i * 11),
  ALDER: (i, sku) => `AH:${sku}`,
  TIDEWATER: (i) => `0${71234500000 + i * 13}`,
};

const PARTNERS = {
  KESTREL: {
    id: 'KESTREL', name: 'Kestrel Outdoor Co.', channel: 'AS2', format: 'x12', interchangeId: 'KESTRELOUTDOOR',
    poPrefix: 'PO45', priceFactor: 0.62, tolerancePct: 1, leadDays: 3, uomMap: { EA: 'EA', CA: 'CS' },
    shipTos: {
      KDC01: { name: 'Kestrel DC Reno', city: 'Reno', region: 'NV' },
      KDC02: { name: 'Kestrel DC Columbus', city: 'Columbus', region: 'OH' },
      KDC03: { name: 'Kestrel DC Allentown', city: 'Allentown', region: 'PA' },
    },
  },
  MARLOWE: {
    id: 'MARLOWE', name: 'Marlowe & Finch Stores', channel: 'HTTPS', format: 'xml',
    poPrefix: 'MF-', priceFactor: 0.65, tolerancePct: 1, leadDays: 3, uomMap: { EA: 'EA', CS: 'CS' },
    shipTos: {
      'M-ATL': { name: 'Marlowe Atlanta', city: 'Atlanta', region: 'GA' },
      'M-DFW': { name: 'Marlowe Dallas', city: 'Dallas', region: 'TX' },
      'M-ORD': { name: 'Marlowe Chicago', city: 'Chicago', region: 'IL' },
    },
  },
  ALDER: {
    id: 'ALDER', name: 'Alder Home Goods', channel: 'REST', format: 'json',
    poPrefix: 'A', priceFactor: 0.6, tolerancePct: 1, leadDays: 2, uomMap: { each: 'EA', case: 'CS' },
    shipTos: {
      'alder-sea': { name: 'Alder Seattle', city: 'Seattle', region: 'WA' },
      'alder-den': { name: 'Alder Denver', city: 'Denver', region: 'CO' },
      'alder-clt': { name: 'Alder Charlotte', city: 'Charlotte', region: 'NC' },
    },
  },
  TIDEWATER: {
    id: 'TIDEWATER', name: 'Tidewater Wholesale', channel: 'SFTP', format: 'csv',
    poPrefix: 'TW', priceFactor: 0.58, tolerancePct: 1, leadDays: 4, uomMap: { EA: 'EA', CASE: 'CS' },
    shipTos: {
      TW1: { name: 'Tidewater Savannah', city: 'Savannah', region: 'GA' },
      TW2: { name: 'Tidewater Long Beach', city: 'Long Beach', region: 'CA' },
      TW3: { name: 'Tidewater Newark', city: 'Newark', region: 'NJ' },
    },
  },
};

export const NEW_ITEM_SKU = 'RC-0020';
export const DISCONTINUED_SKU = 'LN-0100';

export function buildMasterData() {
  const items = {};
  ITEMS.forEach(([sku, description, casePack, listPrice, active]) => {
    items[sku] = { sku, description, casePack, listPrice, active };
  });

  const partners = {};
  for (const [id, def] of Object.entries(PARTNERS)) {
    const xref = {}; // buyer part number -> internal SKU
    const unmapped = {}; // internal SKU -> buyer part number the partner will use once it starts ordering it
    ITEMS.forEach(([sku], i) => {
      const part = partNumber[id](i, sku);
      if (sku === NEW_ITEM_SKU) unmapped[sku] = part;
      else xref[part] = sku;
    });
    partners[id] = { ...def, uomMap: { ...def.uomMap }, shipTos: { ...def.shipTos }, xref, unmapped, addedXref: [] };
  }

  const md = {
    items,
    partners,
    partnerIds: Object.keys(partners),
    // Contract price is per each; a case price is the each price times the case pack.
    contractPrice(partnerId, sku, uom = 'EA') {
      const item = items[sku];
      const each = round2(item.listPrice * partners[partnerId].priceFactor);
      return uom === 'CS' ? round2(each * item.casePack) : each;
    },
    buyerPart(partnerId, sku) {
      const p = partners[partnerId];
      return Object.keys(p.xref).find((k) => p.xref[k] === sku) ?? p.unmapped[sku];
    },
    rawUom(partnerId, canonicalUom) {
      const map = partners[partnerId].uomMap;
      return Object.keys(map).find((k) => map[k] === canonicalUom);
    },
  };
  return md;
}
