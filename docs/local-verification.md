# Local verification

## Commands

```sh
npm ci --ignore-scripts
npm run types
npm run contract:verify
npm run typecheck
npm run lint
npm run test:integration
npm run test:mcp:smoke
npm test
npm run test:coverage
npm run build
npm run skill:package
npm run secret:scan -- --secrets-file ../../../.secrets/iwind.keys.env
set -a; source ../../../.secrets/iwind.keys.env; set +a; npm run test:integration:live
```

## Results

| Test ID | Status | Duration ms | Bytes |
|---|---|---:|---:|
| `LOCAL-OAUTH-MCP-01` | PASS | 291 | - |
| `LOCAL-ROTATION-01` | PASS | - | - |
| `FULL-SUITE-01` | PASS | 10050 | - |
| `COVERAGE-STATEMENTS-01` | PASS 95.44% | - | - |
| `COVERAGE-BRANCHES-01` | PASS 90.14% | - | - |
| `COVERAGE-FUNCTIONS-01` | PASS 97.17% | - | - |
| `COVERAGE-LINES-01` | PASS 97.28% | - | - |
| `BUILD-DRY-RUN-01` | PASS | - | 1749780 |
| `SKILL-PACKAGE-01` | PASS | - | - |
| `EXACT-VALUE-SCAN-01` | PASS | - | - |
| `LIVE-STOCK-01` | PASS | 10981 | 916 |
| `LIVE-FUND-01` | PASS | 5458 | 436 |
| `LIVE-INDEX-01` | PASS | 4170 | 751 |
| `LIVE-ECONOMIC-01` | PASS | 16748 | 1736 |
| `LIVE-DOCS-01` | PASS | 15055 | 24499 |
| `LIVE-ANALYTICS-01` | PASS | 13889 | 227 |
| `LIVE-SERIAL-01` | PASS | - | - |
