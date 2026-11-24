import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireSession } from '../features/session/RequireSession.js';
import { AppShell } from '../features/shell/AppShell.js';
import { AssessmentFormRoute } from './AssessmentFormRoute.js';
import { AssessmentsRoute } from './AssessmentsRoute.js';
import { ConflictRoute } from './ConflictRoute.js';
import { HomeRoute } from './HomeRoute.js';
import { LoginRoute } from './LoginRoute.js';
import { NotFoundRoute } from './NotFoundRoute.js';
import { QueueRoute } from './QueueRoute.js';
import { SectionRoute } from './SectionRoute.js';
import { TaskRoute, TasksRoute } from './TasksRoute.js';
import { NotificationsRoute } from '../features/notifications/NotificationsRoute.js';

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginRoute /> },
    {
      element: <RequireSession />,
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: <HomeRoute /> },
            { path: 'queue', element: <QueueRoute /> },
            { path: 'queue/:itemId/review', element: <ConflictRoute /> },
            { path: 'home', element: <Navigate to="/" replace /> },
            { path: 'assessments', element: <AssessmentsRoute /> },
            { path: 'assessments/:assessmentId', element: <AssessmentFormRoute /> },
            { path: 'tasks', element: <TasksRoute /> },
            { path: 'tasks/:taskId', element: <TaskRoute /> },
            { path: 'notifications', element: <NotificationsRoute /> },
            { path: ':section', element: <SectionRoute /> },
            { path: '*', element: <NotFoundRoute /> },
          ],
        },
      ],
    },
  ],
  { basename, future: { v7_relativeSplatPath: true } },
);
