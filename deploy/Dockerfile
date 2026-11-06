FROM node:26.13.0-bookworm AS workspace
WORKDIR /app
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

FROM workspace AS backend
RUN pnpm --filter vcraft-backend install --frozen-lockfile
COPY backend/ backend/
WORKDIR /app/backend
RUN pnpm run build && mkdir -p /var/lib/vcraft/uploads && chown node:node /var/lib/vcraft/uploads
USER node
CMD ["sh", "-ec", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]

FROM workspace AS frontend-build
RUN pnpm --filter vcraft-frontend install --frozen-lockfile
COPY frontend/ frontend/
RUN pnpm --filter vcraft-frontend run build

FROM nginx:1.30.6-alpine AS frontend
COPY deploy/frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/frontend/dist/ /usr/share/nginx/html/
