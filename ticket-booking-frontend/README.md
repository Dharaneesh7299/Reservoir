# Reservoir: Frontend

The React single-page app for [Reservoir](../README.md): the event catalogue, the booking flow, "My Bookings", sign-in, and the admin event editor.

## Stack

React 19, React Router 7 and Vite 8, styled with plain CSS and shared design tokens (`src/index.css`). In production, Nginx serves the app and proxies `/api` to the Inventory Service (`nginx.conf`).

## Scripts

```bash
npm install
npm run dev       # Vite dev server on :3000, proxies /api → http://localhost:4001
npm run build     # production build into dist/
npm run preview   # serve the production build locally
npm run lint      # Oxlint
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `""` | API base URL. Leave it empty to use same-origin `/api` (Nginx or the Vite proxy) |
| `VITE_API_TARGET` | `http://localhost:4001` | Where the Vite dev server proxies `/api` |

## Layout

```
src/
├── App.jsx              # Routes, navbar, booking modal & flow
├── pages/               # Events.jsx, Bookings.jsx
├── components/          # EventCard, AuthModal, AdminAddTicketsModal
├── context/             # AuthProvider: sessions, token refresh, tab sync
├── services/api.js      # Every backend call
└── index.css            # Design tokens + shared animations
```

For how the app fits into the whole system, see the main [README](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).
