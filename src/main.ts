import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { AppComponent } from './app/app.component';

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const root = document.querySelector('app-root');
  if (root) {
    root.innerHTML = `
      <main style="font-family: Arial, sans-serif; padding: 32px; color: #17202a;">
        <h1 style="font-size: 34px; margin: 0 0 16px;">Memory Companion could not start</h1>
        <p style="font-size: 22px; line-height: 1.4;">${message}</p>
        <p style="font-size: 18px;">Please send this message to the developer.</p>
      </main>
    `;
  }
  console.error(error);
}

window.addEventListener('error', (event) => showStartupError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showStartupError(event.reason));

bootstrapApplication(AppComponent, {
  providers: [provideAnimations()]
}).catch((error) => showStartupError(error));
