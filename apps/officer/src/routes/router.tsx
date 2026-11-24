import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireAuth } from '../features/auth/RequireAuth.js';
import { AppShell } from '../features/shell/AppShell.js';
import { HistoryRoute } from '../features/history/HistoryRoute.js';
import { AdminRoute } from '../features/admin/AdminRoute.js';
import { ChecklistsRoute } from '../features/admin/ChecklistsRoute.js';
import { WithDemoClockBanner } from '../features/admin/DemoClock.js';
import { PlanRoute } from '../features/plans/PlanRoute.js';
import { PlansRoute } from '../features/plans/PlansRoute.js';
import { SupportRoute } from '../features/support/SupportRoute.js';
import { AssessmentsRoute } from '../features/comparison/AssessmentsRoute.js';
import { ComparisonRoute } from '../features/comparison/ComparisonView.js';
import { OversightRoute } from '../features/oversight/OversightRoute.js';
import { TaskQueueRoute, TaskReviewRoute } from '../features/review/ReviewRoutes.js';
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
          {
            // FR-038: demo-clock banner on every signed-in page while programme time is shifted.
            element: <WithDemoClockBanner />,
            children: [
              { index: true, element: <HomeRoute /> },
              { path: 'home', element: <Navigate to="/" replace /> },
              { path: 'history/:subjectType/:subjectId', element: <HistoryRoute /> },
              { path: 'admin', element: <AdminRoute /> },
              { path: 'admin/:tab', element: <AdminRoute /> },
              { path: 'checklists', element: <ChecklistsRoute /> },
              { path: 'plans', element: <PlansRoute /> },
              { path: 'plans/:planId', element: <PlanRoute /> },
              { path: 'assessments', element: <AssessmentsRoute /> },
              { path: 'assessments/:assessmentId/comparison', element: <ComparisonRoute /> },
              { path: 'oversight', element: <OversightRoute /> },
              { path: 'support', element: <SupportRoute /> },
              { path: 'reviews', element: <TaskQueueRoute section="reviews" /> },
              { path: 'reviews/:taskId', element: <TaskReviewRoute section="reviews" /> },
              { path: 'validations', element: <TaskQueueRoute section="validations" /> },
              { path: 'validations/:taskId', element: <TaskReviewRoute section="validations" /> },
              { path: 'tasks', element: <TaskQueueRoute section="tasks" /> },
              { path: 'tasks/:taskId', element: <TaskReviewRoute section="tasks" /> },
              { path: ':section', element: <SectionRoute /> },
              { path: '*', element: <NotFoundRoute /> },
            ],
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes, { basename, future: { v7_relativeSplatPath: true } });
