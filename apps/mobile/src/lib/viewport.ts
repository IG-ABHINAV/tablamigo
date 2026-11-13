// Native builds: the OS resizes the window for the keyboard (KeyboardAvoidingView handles the rest). The web build uses
// viewport.web.ts.
export const useKeyboardOpen = () => false;
export const keyboardOpenNow = () => false;
