"use client";

import ErrorScreen from "./components/ErrorScreen";

export default function GlobalError({ error }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <ErrorScreen error={error} />
      </body>
    </html>
  );
}
