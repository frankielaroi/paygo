#!/usr/bin/env bash
#
# One-time setup so GitHub Actions can deploy without a long-lived AWS access key.
#
# Creates two things:
#   1. an IAM OIDC provider trusting GitHub's token issuer
#   2. the paygo-github-deploy role, which only workflows in this repository on the
#      master branch (or its production environment) can assume
#
# Run it once, with credentials that have IAM rights:
#   bash deploy/github-oidc-setup.sh
#
# This grants a standing capability: from then on, a workflow in this repository can
# obtain the permissions below. That is why it is a separate, deliberate step rather
# than part of the deploy, and why the trust policy names the branch instead of
# allowing "any ref in the repo": a pull request from a fork must not be able to push
# an image or run a command on the instance.
set -euo pipefail

AWS_REGION="eu-north-1"
ACCOUNT_ID="813283043080"
GITHUB_REPO="frankielaroi/paygo"
ROLE_NAME="paygo-github-deploy"
INSTANCE_ID="i-0220b4264b42d3958"
ECR_REPOSITORY="paygo-api"

PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

echo "==> IAM OIDC provider"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" >/dev/null 2>&1; then
  echo "    already exists, leaving it alone"
else
  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" \
    --query 'OpenIDConnectProviderArn' --output text
fi

echo "==> trust policy"
TRUST="$(mktemp)"
cat > "${TRUST}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:${GITHUB_REPO}:ref:refs/heads/master",
            "repo:${GITHUB_REPO}:environment:production"
          ]
        }
      }
    }
  ]
}
JSON

echo "==> permission policy"
PERMS="$(mktemp)"
cat > "${PERMS}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPushPullThisRepoOnly",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPOSITORY}"
    },
    {
      "Sid": "SetTheDeployedImage",
      "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/paygo/image"
    },
    {
      "Sid": "ReadTheDatabaseUrlForMigrations",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/paygo/env/DATABASE_URL"
    },
    {
      "Sid": "DecryptParametersViaSsmOnly",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "kms:ViaService": "ssm.${AWS_REGION}.amazonaws.com" }
      }
    },
    {
      "Sid": "RunTheDeployScriptOnThisInstanceOnly",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}",
        "arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadBackTheCommandResult",
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
JSON

echo "==> role ${ROLE_NAME}"
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "    exists, updating the trust policy"
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "file://${TRUST}"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${TRUST}" \
    --description "GitHub Actions deploys for ${GITHUB_REPO}" \
    --max-session-duration 3600 \
    --query 'Role.Arn' --output text
fi

aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "paygo-deploy" \
  --policy-document "file://${PERMS}"

rm -f "${TRUST}" "${PERMS}"

echo
echo "Done. The role ARN below is already set as AWS_ROLE_ARN in"
echo ".github/workflows/deploy.yml, so nothing further is needed there."
aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text
