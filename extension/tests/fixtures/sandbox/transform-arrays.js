// Transform: return plain arrays with explicit columns.
return {
  columns: ["ad_id", "doubled"],
  rows: inputs.sales.arrays.map(([id, spend]) => [id, spend * 2]),
};
