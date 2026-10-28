import test from "node:test";
import assert from "node:assert/strict";
import { isSolanaMainnet } from "../src/lib/sentinel/network-policy";

test("network verification accepts the full Solana mainnet genesis hash only", () => {
  assert.equal(isSolanaMainnet("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), true);
  for (const wrong of [
    "",
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  ]) {
    assert.equal(isSolanaMainnet(wrong), false);
  }
});
