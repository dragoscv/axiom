
# AXIOM Syntax (MVP)

- **agent "<name>" { ... }**
- Sections: **intent**, **constraints { ... }**, **capabilities { ... }**, **checks { ... }**, **emit { ... }**
- Expressions in intent/constraints must be *pure* (no effects).
- No technology names appear in the language (no Next.js, Fastify, etc.).

Example:
```
agent "blog" {
  intent "blog public cu admin"
  constraints { latency_p50_ms <= 80, monthly_budget_usd <= 3, pii_leak == false }
  capabilities { fs("./out") }
  checks {
    policy "no-pii" expect scan.artifacts.no_personal_data()
    sla "p50" expect latency_p50_ms <= 80
  }
  emit {
    service type="web-app"     target="./out/web"
    service type="api-service" target="./out/api"
    manifest target="./out/axiom.json"
  }
}
```
