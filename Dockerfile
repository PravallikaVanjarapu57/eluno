# One container, one public origin: the till API serves the built React UI and the supplied mock
# (Shopify Admin + store tool + terminal) runs beside it on an internal port.
FROM node:22-bookworm-slim

# python3: the starter-kit mock. make/g++: fallback build for better-sqlite3 if no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --no-audit --no-fund

COPY frontend frontend
RUN cd frontend && npm run build
COPY backend backend

WORKDIR /app/backend
ENV PORT=3000 MOCK_PORT=8787 FRONTEND_DIR=/app/frontend/dist TILL_RESET_DB=1
# Authentication: production mode turns on Secure (+ __Host-) session cookies. TRUST_PROXY=1 because Render terminates TLS in
# front of the container. The scrypt cost is one notch lower than the default (16 MiB) because a free instance has a fraction
# of a CPU; raise AUTH_SCRYPT_LOG2N on real hardware. No password is baked in: supply AUTH_DEMO_PASSWORD (>= 12 chars) at run
# time, or no accounts exist and nobody can sign in. For plain-HTTP local use of this image add -e COOKIE_SECURE=0.
ENV NODE_ENV=production TRUST_PROXY=1 AUTH_SCRYPT_LOG2N=14
EXPOSE 3000
# Starts the mock on :8787, waits for it, then the API (serving the UI) on $PORT.
# The till's SQLite file and the mock's memory both live in this container, so they reset together.
# node (not npm) is PID 1 so Render's SIGTERM reaches the supervisor, which stops the mock and the API.
CMD ["node", "--import", "tsx", "scripts/start.ts"]
