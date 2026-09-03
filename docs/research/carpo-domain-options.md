# Carpo domain options

Originally checked at **2026-09-03T17:07:04Z**. `carpo.video` was registered later that day and is now the configured canonical production domain. The availability table below is retained as decision history.

## Recommendation

Use **`carpo.video` as the canonical product domain**. It keeps the exact product
name and explains the product category without extra copy. At research time,
Cloudflare's public Registrar search showed it as purchasable for **$28.20**,
renewing at **$28.20**. If a second defensive domain is worth another **$10.46**
per year, also buy **`usecarpo.com`** and redirect it to `carpo.video`.

If only a `.com` is wanted, choose `usecarpo.com`. If immediate product clarity
matters more than preserving the exact spoken name, `carpoclips.com` is the best
descriptive `.com` fallback.

These are discovery-time results, not reserved inventory. Cloudflare says its
search results can be cached and that a real-time registry check must be made
immediately before registration; the final purchase flow also performs a
definitive availability check. [Cloudflare Registrar API workflow](https://developers.cloudflare.com/registrar/registrar-api/)
[Cloudflare registration guide](https://developers.cloudflare.com/registrar/get-started/register-domain/)

## Shortlist

| Candidate | Registry signal | Cloudflare public search | Product fit |
| --- | --- | --- | --- |
| **`carpo.video`** | No `.video` RDAP object (404) | **Purchase — $28.20; renews $28.20** | Best exact-name choice. The suffix makes Carpo's video purpose explicit. |
| **`usecarpo.com`** | No `.com` RDAP object (404) | **Purchase — $10.46; renews $10.46** | Best conventional `.com`; natural to say and useful as a redirect even if `.video` is primary. |
| **`carpoclips.com`** | No `.com` RDAP object (404) | **Purchase — $10.46; renews $10.46** | Most descriptive `.com`, but slightly changes the brand from “Carpo” to “Carpo Clips.” |
| `trycarpo.com` | No `.com` RDAP object (404) | Purchase — $10.46; renews $10.46 | Good launch/demo URL; feels more temporary than a permanent product home. |
| `clipwithcarpo.com` | No `.com` RDAP object (404) | Purchase — $10.46; renews $10.46 | Clear call to action, but long. |
| `carpoclip.com` | No `.com` RDAP object (404) | Purchase — $10.46; renews $10.46 | Short and clear enough, but singular reads less naturally than `carpoclips.com`. |
| `carpo.studio` | No `.studio` RDAP object (404) | Purchase — $31.20; renews $31.20 | Attractive creative identity, but implies a broader editing suite than Carpo's high-throughput clip workflow. |
| `carpo.tools` | No `.tools` RDAP object (404) | Purchase — $28.20; renews $28.20 | Strong developer-tool signal; weak choice for a creator-facing product. |
| `carpo.media` | No `.media` RDAP object (404) | Purchase — $35.20; renews $35.20 | Leaves room to expand, but is less focused and the most expensive shortlisted option. |
| `carpo.dev` | No `.dev` RDAP object (404) | Not price-checked | Better for developer documentation than the product itself. |

Cloudflare search links for the leading choices: [`carpo.video`](https://domains.cloudflare.com/?domain=carpo.video),
[`usecarpo.com`](https://domains.cloudflare.com/?domain=usecarpo.com),
[`carpoclips.com`](https://domains.cloudflare.com/?domain=carpoclips.com),
[`trycarpo.com`](https://domains.cloudflare.com/?domain=trycarpo.com),
[`clipwithcarpo.com`](https://domains.cloudflare.com/?domain=clipwithcarpo.com),
[`carpoclip.com`](https://domains.cloudflare.com/?domain=carpoclip.com),
[`carpo.studio`](https://domains.cloudflare.com/?domain=carpo.studio),
[`carpo.tools`](https://domains.cloudflare.com/?domain=carpo.tools), and
[`carpo.media`](https://domains.cloudflare.com/?domain=carpo.media).

## Exact names that are already registered

| Candidate | Current registry record | Practical conclusion |
| --- | --- | --- |
| `carpo.com` | Registered 2003-06-29; current record expires 2027-06-29. [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/carpo.com) | Not available through ordinary registration. It would require a secondary-market purchase or owner negotiation. |
| `carpo.ai` | Registered 2024-12-20; current record expires 2028-12-20. [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/domain/carpo.ai) | Not available. It also over-emphasizes the implementation technology instead of the clipping job Carpo performs. |
| `carpo.app` | Registered 2025-12-14; current record expires 2026-12-14. [Google Registry RDAP](https://pubapi.registry.google/rdap/domain/carpo.app) | Not available, and it is an active, unrelated carpool-orchestration product. |
| `getcarpo.com` | Registered 2025-08-21; current record expires 2027-08-21. [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/getcarpo.com) | Not available despite currently using expired-domain nameservers. Do not treat an inactive site as a free domain. |

The live [`carpo.app`](https://carpo.app/) site describes software “for
orchestrating carpools at scale.” There is also a long-running unrelated food
and retail brand called Carpo, founded in Athens in 1991. [Carpo retail brand history](https://carpoworld.com/our-story/)
These do not determine whether the video product may use the name, but they do
mean the name is not globally unique.

Domain availability is not trademark clearance. Before a broad commercial
launch, search for confusingly similar marks in the relevant software/media
classes and consider professional clearance. The USPTO recommends searching
federal records, state registrations, and unregistered uses—not just exact
domain names. [USPTO clearance guidance](https://www.uspto.gov/TrademarkBasicsToolkit)

## How the status was determined

IANA identifies the authoritative RDAP services for the relevant registries:
Verisign for `.com`, Google Registry for `.app` and `.dev`, and Identity Digital
for `.ai`, `.video`, `.studio`, `.tools`, and `.media`.
[IANA `.com` delegation](https://www.iana.org/domains/root/db/com.html)
[IANA `.ai` delegation](https://www.iana.org/domains/root/db/ai.html)
[IANA `.app` delegation](https://www.iana.org/domains/root/db/app.html)
[IANA `.video` delegation](https://www.iana.org/domains/root/db/video.html)

At the timestamp above:

- HTTP 200 plus a domain object was treated as **registered**.
- HTTP 404 / no domain object was treated as **no current registry record**,
  not as a guarantee that the name is registrable. Reserved, premium, policy-
  restricted, or just-registered names can still fail the registrar's final
  check.
- A visible **Purchase** result and displayed price on Cloudflare's public
  search was recorded as a stronger discovery signal, but not a reservation.

## Cloudflare fit and cutover implications

Cloudflare supports the TLDs above and charges the registry/ICANN price without
markup. Registrar domains use Cloudflare nameservers, include DNSSEC support,
and receive WHOIS redaction where the registry permits it.
[Cloudflare Registrar overview](https://developers.cloudflare.com/registrar/)
[Cloudflare supported TLDs](https://www.cloudflare.com/tld-policies/)

Carpo now attaches `carpo.video` directly to the existing Worker as a Custom
Domain; Cloudflare created the DNS record and managed certificate. The cutover
reused the existing Access application and audience for the private paths while
preserving the intentional public paths (`/`, `/sign-in`, `/demo/*`, and
`/share/*`). The local helper was moved to the custom origin, the production
`workers.dev` URL was disabled, and the launch-access smoke check was rerun.
[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
[Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
