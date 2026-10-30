// Transform: return a bare array of objects with mixed keys.
return inputs.sales.rows.map((r, i) => (i === 0 ? { ad_id: r.ad_id } : { ad_id: r.ad_id, note: "x", ratio: r.spend / 3 }));
