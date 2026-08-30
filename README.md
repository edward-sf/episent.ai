# episent.ai
An edge-deployed epidemiological anomaly detector utilizing Cloudflare Workers AI and Vectorize to identify and match regional outbreak patterns.

**Domains:** `Public Health`, `AI`

## Tech Stack

- **Cloudflare Workers AI**
- **Cloudflare Vectorize**
- **Supabase Database**

## Architecture

Creates an edge API that ingests outbreak data and generates embeddings. It queries similar past outbreaks using Cloudflare Vectorize, while storing raw demographic datasets in Supabase Postgres.
