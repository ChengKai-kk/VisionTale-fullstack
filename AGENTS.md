# Repository Guidelines

## Project Structure & Module Organization
- `storybook-agent/` contains the main FastAPI backend (`main.py`, `ark_client.py`, `generation.py`, `story.py`) and a Modern.js + React frontend under `storybook-agent/frontend/` (app source in `storybook-agent/frontend/src/storybook-web/`).
- `visiontale_front/` is a Vue 3 + Vite web client; source lives in `visiontale_front/src/`, static assets in `visiontale_front/public/`.
- `visiontale_backend/` is a small Node.js service; entrypoint is `visiontale_backend/server.js`, with supporting code in `visiontale_backend/src/`.

## Build, Test, and Development Commands
- `cd storybook-agent && pip install -r requirements.txt`: install FastAPI backend deps.
- `cd storybook-agent && python main.py`: run the Storybook Agent API locally.
- `cd storybook-agent/frontend && pnpm install`: install frontend deps.
- `cd storybook-agent/frontend && pnpm dev`: start the Modern.js dev server.
- `cd storybook-agent/frontend && pnpm build`: build production assets.
- `cd visiontale_front && npm install`: install Vue app deps.
- `cd visiontale_front && npm run dev`: run the Vite dev server.
- `cd visiontale_front && npm run build`: build the Vue app.
- `cd visiontale_backend && npm install`: install backend deps.
- `cd visiontale_backend && npm start`: start the Node server.

## Coding Style & Naming Conventions
- Python code uses 4-space indentation and `snake_case` for functions/variables.
- Storybook Agent frontend uses Biome (`pnpm lint`) with single quotes, 80-char lines, and organized imports; keep React components in `PascalCase` and hooks in `camelCase`.
- Vue and Node code should follow existing 2-space indentation and current file naming patterns in `src/`.

## Testing Guidelines
- No automated test suite is wired up. The only manual script is `storybook-agent/scripts/test_image_generation.py`.
- If you add tests, keep them close to the code they cover (e.g., `src/__tests__/`) and document how to run them here.

## Commit & Pull Request Guidelines
- Recent commits follow Conventional Commit-style prefixes (e.g., `chore: ...`, `docs: ...`). Match this format.
- PRs should include a short summary, linked issue (if any), and screenshots or recordings for UI changes.

## Configuration & Secrets
- Copy `storybook-agent/.env.example` to `storybook-agent/.env` and set `ARK_API_KEY`/`ARK_BASE_URL` before running the API.
- `visiontale_front/.env.local` can hold frontend-only environment overrides; do not commit secrets.
