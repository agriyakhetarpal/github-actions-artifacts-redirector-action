// github-actions-artifacts-redirector-action
//
// Inspired by https://github.com/scientific-python/circleci-artifacts-redirector-action/,
// but for GitHub Actions artifacts. When it's triggered by the `workflow_run` event, it will:
//
//   1. map the workflow run state ➡️ GitHub commit status state
//   2. find the artifact by name using the GitHub REST API
//   3. create a commit status whose `target_url` points directly to the artifact. See
//      https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#about-commit-statuses
//
// This will give you a clickable check in the PR checks list on the commit and at
// the bottom of the PR thread, that opens the artifact (e.g. docs preview, coverage report)
// in a new tab in your browser. It's not perfect (e.g. no direct link to the artifact while the workflow is pending), but it's
// in the veins of the GitHub UI and should help you get to the artifact faster by saving a few clicks!
//
// N.B. after changing this file, rebuild it with:
//   ncc build index.js
// or let the autofix.ci bot do it on your PR (TODO add autofix.ci config and set up bot permissions)

import * as core from "@actions/core";
import * as github from "@actions/github";

async function run() {
  try {
    core.debug(new Date().toTimeString());

    const token = core.getInput("repo-token", { required: true });
    const artifactName =
      core.getInput("artifact-name", { required: false }) || "";
    let jobTitle = core.getInput("job-title", { required: false }) || "";

    const payload = github.context.payload;
    const workflowRun = payload.workflow_run;

    if (!workflowRun) {
      core.setFailed(
        "This action must be triggered by the `workflow_run` event. " +
          "See the README for a sample workflow.",
      );
      return;
    }

    const sha = workflowRun.head_sha;
    const runId = workflowRun.id;
    const runStatus = workflowRun.status; // queued, in_progress, or completed
    const conclusion = workflowRun.conclusion; // success, failure, cancelled,  …, or null

    const client = github.getOctokit(token);
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    core.debug(
      `workflow run: ${workflowRun.name}  status: ${runStatus}  conclusion: ${conclusion}`,
    );
    core.debug(`head SHA: ${sha}  run ID: ${runId}`);

    // Don't post a status for cancelled/skipped runs. They are not real failures,
    // just a superseded run. Posting errors are causing some strange misleading red commit
    // statuses don't reflect the real state of the CI.
    if (conclusion === "cancelled" || conclusion === "skipped") {
      core.info(`Workflow run was ${conclusion}, skipping status update`);
      return;
    }

    // ------------------------------------------------------------------
    // 1. Map workflow_run state → commit status state
    //    pending  → workflow hasn't finished yet
    //    success  → workflow succeeded (we'll find and link the artifact)
    //    failure  → workflow failed (link to the run page so devs can see why)
    //    error    → anything else (cancelled, timed_out, etc.)
    // ------------------------------------------------------------------
    let commitState;
    if (runStatus !== "completed") {
      commitState = "pending";
    } else if (conclusion === "success") {
      commitState = "success";
    } else if (conclusion === "failure") {
      commitState = "failure";
    } else {
      commitState = "error";
    }

    core.debug(`mapped commit status state: ${commitState}`);

    // ------------------------------------------------------------------
    // 2. Determine target URL
    //    - While pending: point to the running workflow (best we can do)
    //    - On success: find the artifact and point directly to it
    //    - On failure/error: point to the workflow run page
    // ------------------------------------------------------------------
    let targetUrl = workflowRun.html_url;
    let description = "";

    if (commitState === "pending") {
      description = `Waiting for ${workflowRun.name} …`;
    } else {
      // Query the artifacts for this run (on both success and failure,
      // since artifacts may still be uploaded when the build fails via
      // `if: always()` on the upload step)
      const { data } = await client.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
      });

      core.debug(`found ${data.total_count} artifact(s) for run ${runId}`);
      data.artifacts.forEach((a) =>
        core.debug(`  artifact: "${a.name}" id=${a.id}`),
      );

      let artifact = null;

      if (artifactName !== "") {
        // Do an exact match on the artifact name, then a partial match if no exact match is found. This
        // should allows some flexibility in the artifact name, e.g. to ignore a dynamic suffix.
        artifact = data.artifacts.find((a) => a.name === artifactName);
        if (!artifact) {
          artifact = data.artifacts.find((a) => a.name.includes(artifactName));
          if (artifact) {
            core.debug(
              `no exact match for "${artifactName}", using partial match: "${artifact.name}"`,
            );
          }
        }
      } else {
        artifact = data.artifacts[0] ?? null;
        if (artifact) {
          core.debug(
            `no artifact-name specified, using first: "${artifact.name}"`,
          );
        }
      }

      if (artifact) {
        // Construction for the standard GitHub artifact view URL.
        // For upload-artifact@v7 with `archive: false`, GitHub serves the raw
        // file at this URL so the browser opens it directly (HTML, image, etc.)
        // For v4/v5/v6 (zipped), this URL will trigger a zip download (TODO test if that will work or not).
        targetUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}/artifacts/${artifact.id}`;
        description =
          commitState === "success"
            ? `Link to ${artifact.name}`
            : `${workflowRun.name} failed — see ${artifact.name}`;
        core.setOutput("url", targetUrl);
        core.debug(`artifact URL: ${targetUrl}`);
      } else {
        core.warning(
          artifactName
            ? `Artifact "${artifactName}" not found in run ${runId}. Falling back to run URL.`
            : `No artifacts found in run ${runId}. Falling back to run URL.`,
        );
        description =
          commitState === "success"
            ? "Artifact not found — see run"
            : `${workflowRun.name} did not succeed`;
      }
    }

    // ------------------------------------------------------------------
    // 3. Create the commit status
    //    This shows up as a named check in the PR checks list, with a
    //    "Details" link that opens the artifact (or run page) directly.
    // ------------------------------------------------------------------
    if (jobTitle === "") {
      jobTitle = `${workflowRun.name} artifact`;
    }

    core.debug(
      `creating commit status: state=${commitState} context="${jobTitle}"`,
    );
    core.debug(`  sha=${sha}  url=${targetUrl}`);

    await client.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: commitState,
      target_url: targetUrl,
      description: description.slice(0, 140), // 140 char limit on description field
      context: jobTitle,
    });

    core.debug(new Date().toTimeString());
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
