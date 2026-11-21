# Connect Firebase Cloud Messaging

{{pluginName}} sends push notifications to the Capybara Android app through the FCM HTTP v1 API,
signed in as a Google service account of your Firebase project.

1. In the [Firebase console](https://console.firebase.google.com/), open the project that holds
   your Android app (or create one and add the app with its application id).
2. Open **Project settings → Cloud Messaging** and make sure **Firebase Cloud Messaging API (V1)**
   is enabled.
3. Open **Project settings → Service accounts** and choose **Generate new private key**. A JSON key
   file downloads; keep it safe, it is a credential.
4. On this page, paste the whole file into **Service account key (JSON)** (`serviceAccount`) and
   list the Android application ids the app is built with in `applicationIds`, then save.

The key is stored encrypted and never shown again. To rotate it, generate a new key, save it here,
then delete the old key in the Google Cloud console.

::check fcm-credentials Google accepts the service account key
