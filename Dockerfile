FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY index.ts ./
COPY src/ ./src/

RUN npm run build


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=prod
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
