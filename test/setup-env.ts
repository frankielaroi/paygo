// Runs before each e2e file is loaded. ConfigModule does not override variables already in the
// environment, so this only supplies values .env lacks: a throwaway Paystack key the suites sign
// webhooks with. It is not a real key and never leaves the test process.
process.env.PAYSTACK_SECRET_KEY ??= 'sk_test_e2e_only_not_a_real_key';

// Never text a real phone from a test run, whatever .env says: an empty key selects the
// development log channel, and the notification timer stays off so suites drive it explicitly.
process.env.ARKESEL_API_KEY = '';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.ARKESEL_CALLBACK_TOKEN ??= 'e2e-callback-token-0123456789abcdef';
