// Runs before each e2e file is loaded. ConfigModule does not override variables already in the
// environment, so this only supplies values .env lacks: a throwaway Paystack key the suites sign
// webhooks with. It is not a real key and never leaves the test process.
process.env.PAYSTACK_SECRET_KEY ??= 'sk_test_e2e_only_not_a_real_key';
