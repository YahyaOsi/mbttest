/** Synthetic role-separated endpoints; never use live provider configuration. */
export function fixtureRpcPool(url = "https://fixture.invalid") {
  const keys = Array.from({ length: 6 }, (_, i) => `RPC_URL_${i + 1}`);
  const previous = keys.map(k => process.env[k]);
  for (const key of keys) delete process.env[key];
  process.env.RPC_URL_1 = `${url}?fixture-role=background-1`;
  process.env.RPC_URL_2 = `${url}?fixture-role=background-2`;
  process.env.RPC_URL_3 = url;
  return () => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  });
}
