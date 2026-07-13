FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
