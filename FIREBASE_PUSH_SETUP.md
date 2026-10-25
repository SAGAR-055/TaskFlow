# Firebase background push setup

TaskFlow can send deadline, overdue, habit, and daily-planning reminders while the app is closed. This integration uses Firebase Anonymous Authentication, Cloud Firestore, Firebase Cloud Messaging, and a scheduled Cloud Function.

## Firebase project setup

1. Create a Firebase project and register a Web app.
2. Under Authentication > Sign-in method, enable **Google** for account sign-in and cross-device sync. Enable **Anonymous** to keep background push available to users who have not signed in. Under Authentication > Settings > Authorized domains, add every hostname used to open the app, including your local development hostname and deployed or preview hostname. Enter only the hostname (for example, `my-app.web.app`), without `https://` or a port. If sign-in reports `auth/unauthorized-domain`, add the hostname shown in the app's error message and try again.
3. Create the Cloud Firestore database.
4. In Project settings > Cloud Messaging, generate a Web Push certificate key pair (VAPID key).
5. Set up a Firebase billing plan that supports scheduled functions. Scheduled reminders run once per minute and use Cloud Scheduler, which requires the Blaze plan.
6. Configure this project's runtime values:
   - For local development, copy `.env.example` to `.env.local` and fill in the Firebase Web app values and public VAPID key.
   - For GitHub Pages, add the same values as GitHub Actions **repository variables** named `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, and `VITE_FIREBASE_VAPID_KEY`. These are public browser configuration values, not private service-account credentials.
7. Install the Firebase CLI (`npm install --global firebase-tools`), authenticate with `firebase login`, and select the project with `firebase use --add`.
8. Deploy the Firestore rules and scheduled function from the repository root:

   ```sh
   firebase deploy --only firestore:rules,functions
   ```

   The deploy command builds the TypeScript function before publishing it.
9. Rebuild and deploy the website after configuring the GitHub variables. Open TaskFlow over HTTPS, open Notifications, and choose **Enable background push** on each device.

## Behavior and platform notes

- Google sign-in syncs tasks and habits through Firestore in real time. On the first sign-in on a device, existing local tasks and habits are merged into the Google account; matching IDs from that device take precedence.
- Users who have not signed in can still use local tasks and habits. Background push uses Firebase Authentication and stores reminder schedules in Firestore for the current account.
- Clearing browser data can remove the local cache and anonymous push account. Google-synced tasks and habits remain in Firestore and can be restored by signing in again.
- On iPhone and iPad, install TaskFlow to the Home Screen and use a supported iOS/iPadOS version (16.4 or later) before enabling web push.
- If a Firebase deployment is not configured, in-app reminders continue to work while TaskFlow is open.
