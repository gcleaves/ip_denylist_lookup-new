FROM node:20-alpine AS builder
WORKDIR /code
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /code
COPY --from=builder /code/node_modules ./node_modules
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
CMD ["node", "--expose-gc", "launch.js"]
