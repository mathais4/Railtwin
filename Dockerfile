FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build:web
ENV PORT=3000
EXPOSE 3000
# Migrate and seed (idempotent), then serve the API and UI.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then npx tsx scripts/seed.ts; fi && npx tsx src/api/server.ts"]
