# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Stage 2: Production
FROM node:18-alpine AS production
WORKDIR /app
RUN addgroup -S cascade && adduser -S cascade -G cascade
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist/
USER cascade
ENTRYPOINT ["node", "dist/index.js"]
