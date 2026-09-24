# Quai receiving proxy static-analysis record

Date: 2026-09-22

Scope:

- `contracts/QuaiSafeProxy.sol`
- `contracts/QuaiSafeProxyFactory.sol`
- `contracts/IQuaiProxyCreationCallback.sol`

Tool: Trail of Bits Slither `0.11.6`, installed into an isolated temporary
virtual environment. The scan completed successfully with 102 detectors over
25 compiled contracts.

Command:

```text
slither . --compile-force-framework hardhat --filter-paths 'contracts/test|node_modules' --exclude-dependencies
```

## Results and disposition

No authorization, reentrancy, arbitrary-send, uninitialized-state, shadowing,
or value-loss finding was reported for the receiving profile.

The only medium-severity report was `locked-ether` on `QuaiSafeProxy`. This is
an expected proxy false positive: Slither does not infer that the payable
fallback delegates Safe's owner-authorized `execTransaction`, which can send
the proxy's native balance. The contract tests fund the proxy and spend the
balance through that unchanged Safe path.

The remaining reports are expected consequences of preserving Safe 1.4.1:

- Inline assembly is copied from `SafeProxy` and `SafeProxyFactory` 1.4.1.
- Solidity 0.7.6 and its pragma range match the pinned upstream release.
- `_singleton` parameter names and the padded `masterCopy()` selector match
  upstream source.
- `singleton` must remain mutable storage slot zero for delegated Safe storage;
  declaring it `immutable` would break the proxy layout.

This is an automated static-analysis pass, not an external human audit. The
profile must still pass a focused independent review before broad production
TVL.
