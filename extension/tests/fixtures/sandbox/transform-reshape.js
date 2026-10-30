// Transform: join sales to ads by ad_id and return objects plus a variable.
const names = new Map(inputs.ads.rows.map((a) => [a.ad_id, a.name]));
const rows = inputs.sales.rows.map((s) => ({
  ad_id: s.ad_id,
  name: names.get(s.ad_id) ?? null,
  spend: s.spend,
  big: s.spend > 10,
}));
return { rows, vars: { total: rows.reduce((t, r) => t + r.spend, 0), min_date: vars.start_date } };
