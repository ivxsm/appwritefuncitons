# generate-map (Appwrite Function)

Node function: Mapbox Static Images → optional Sharp logo overlay → upload PNG to Appwrite Storage.

## Deploy (Appwrite Console)

1. Create function **generate-map**, runtime **Node 18+**, entrypoint **`src/main.js`**, root folder = this directory (`generate-map`).
2. Build command: `npm install`.
3. Add variables (Function → Settings → Variables):

| Variable | Value |
|----------|--------|
| `APPWRITE_ENDPOINT` | Same as your project API endpoint, e.g. `https://cloud.appwrite.io/v1` |
| `MAPBOX_SECRET_TOKEN` | Mapbox secret token (Static Images + Geocoding scopes as needed) |
| `BUCKET_LOGOS` | Bucket ID for user logos |
| `BUCKET_EXPORTS` | Bucket ID for generated PNGs |

`APPWRITE_FUNCTION_PROJECT_ID` is injected automatically.

4. Under **Execute**, allow **users** (or authenticated role) so the web app can run the function with a session.
5. Deploy, then copy the function **ID** into `NEXT_PUBLIC_APPWRITE_FUNCTION_GENERATE_MAP` in `.env.local`.

## Buckets (Console)

- **logos**: File-level security on; allow authenticated users to **create** / **read** / **update** / **delete** files (or equivalent for your security model).
- **exports**: Same pattern; the function attaches `read` permission for the creating user only.

## Local folder

Do not commit `node_modules` here; Appwrite’s build runs `npm install`.
