export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Subjects often start with a proper noun (HTTP, PG, Nacos, CLA), and older ones are in Chinese, so case rules do not apply
    "subject-case": [0],
  },
};
