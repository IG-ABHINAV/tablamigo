// The /paywall route. The two screens live in ../screens/Paywall.tsx (Google Play Billing, used on Android) and
// ../screens/Paywall.web.tsx (Razorpay Checkout, used on the web app), and Metro picks one by platform extension.
//
// They are NOT in src/app on purpose. Expo Router builds the native route table from every file under src/app and
// bundles all of them, *.web.tsx included, so while paywall.web.tsx sat here the Razorpay web checkout
// (checkout.razorpay.com) and its copy shipped inside the Play binary. Nothing under src/app may be web-only.
export { default } from '../screens/Paywall';
