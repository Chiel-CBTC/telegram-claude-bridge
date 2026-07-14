FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The Claude Agent SDK stores/resumes session transcripts under $HOME/.claude/projects/,
# keyed by the agent's cwd ('/home/chiel'). The container runs as root, whose default
# HOME is /root — without this, session resume fails with "No conversation found",
# even though /home/chiel itself is correctly bind-mounted from the host.
ENV HOME=/home/chiel
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
