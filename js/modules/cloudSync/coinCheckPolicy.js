// User policy: dates are ordered instants, not a manual conflict choice.
// Invalid/absent dates never displace a valid check. Does not select a balance.
export function latestCoinCheck(local, cloud) {
  const a = Date.parse(local),
    b = Date.parse(cloud);
  if (!Number.isFinite(b)) return local ?? cloud ?? null;
  if (!Number.isFinite(a)) return cloud;
  return b > a ? cloud : local;
}
