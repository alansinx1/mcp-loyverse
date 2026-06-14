FROM node:22-alpine
WORKDIR /app

# Instala dependencias
COPY package*.json ./
RUN npm install --omit=dev

# Copia el código
COPY . .

# Puerto del MCP en modo HTTP
EXPOSE 5001
ENV PORT=5001

CMD ["node", "http.js"]
