import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireAuth } from '../features/auth/RequireAuth.js';
import { AppShell } from '../features/shell/AppShell.js';
import { HomeRoute } from './HomeRoute.js';
import { LoginRoute } from './LoginRoute.js';
import { NotFoundRoute } from './NotFoundRoute.js';
import { SectionRoute } from './SectionRoute.js';
import { StyleRoute } from './StyleRoute.js';

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

export const routes = [
  { path: '/login', element: <LoginRoute /> },
  { path: '/style', element: <StyleRoute /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRoute /> },
          { path: 'home', element: <Navigate to="/" replace /> },
          { path: ':section', element: <SectionRoute /> },
          { path: '*', element: <NotFoundRoute /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes, { basename, future: { v7_relativeSplatPath: true } });
