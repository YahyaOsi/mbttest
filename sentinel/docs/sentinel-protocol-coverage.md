# On-chain protocol and LP coverage

## Native launchpad curves

- **Pump.fun:** canonical native program/curve and vault ownership, supported mint program/extensions, revoked authorities, actual reserves, creator allocation and holder evidence. Native buys/sells use supported local builders; no ordinary Raydium LP certificate is demanded while the verified curve is active.
- **Moonit CP-V1:** only the explicitly supported, locally decoded native curve version and program identities. New SDK migration enums must not be treated as an older approved Moonshot/Raydium destination.
- A launchpad name, ticker suffix, website badge or aggregator label is never proof of program identity or permanent protection.
- Stonk, PONS, Bags and other brands do not receive blanket exemptions. They qualify only through an already supported and independently verified on-chain route. Withdrawable DBC liquidity stays blocked for new entries; rescue sells must remain available where executable.

## Ordinary pools

The existing verifier covers **Raydium CPMM** and **Raydium AMM v4** SOL pools through supported layouts, canonical program/authority/vault checks and LP mint/account evidence.

Accepted permanent-protection cases are:

1. LP supply proven fully burned under the supported pool accounting; or
2. All outstanding LP proven in permanently inaccessible custody accepted by the verifier.

Partial burn, unknown outstanding custody, future-unlock/time-lock claims, delegated/withdrawable custody and an unrecognized locker program do not qualify.

No additional locker adapter was added without adequate on-chain evidence. A “well-known” name alone cannot establish irrevocability. Future adapters must prove program identity/version, canonical accounts, token custody, withdrawal authority, unlock semantics, all outstanding LP coverage and dangerous extension/delegate absence. Include negative fixtures for admin withdrawal, partial coverage, expired/time locks and spoofed account owners before enabling an adapter.

## Graduations and routing

Graduation is not automatic permission to use an arbitrary pool. Revalidate the supported destination, current vaults, reserves and route. Migration gaps are reported as unavailable routes rather than invented fills. A Jupiter quote is execution data, not permanent LP or safety proof.
