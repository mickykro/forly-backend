(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("token"),
    phone = "",
    status = document.getElementById("claimStatus"),
    codeForm = document.getElementById("claimCodeForm"),
    claimForm = document.getElementById("claimForm");
  function request(action, body) {
    return FLY.req(
      "/api/outreach/demos/" + encodeURIComponent(token) + "/" + action,
      { method: "POST", body: body, noRedirect: true },
    );
  }
  function error(e) {
    status.textContent =
      e.code === "rate_limited"
        ? "Please wait before requesting another code."
        : e.code === "invalid_code"
          ? "The code is invalid or expired. Request a new code."
          : "The claim is unavailable. Please contact Forly.";
  }
  codeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!token) return;
    phone = codeForm.phone.value;
    var button = codeForm.querySelector("button");
    button.disabled = true;
    request("otp", { phone: phone })
      .then(function () {
        claimForm.hidden = false;
        status.textContent = "Enter the code sent to your WhatsApp.";
      })
      .catch(error)
      .then(function () {
        button.disabled = false;
      });
  });
  claimForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var button = claimForm.querySelector("button");
    button.disabled = true;
    request("verify", {
      phone: phone,
      code: claimForm.code.value,
      acknowledged: document.getElementById("claimAcknowledged").checked,
    })
      .then(function () {
        status.textContent =
          "Your verified request is awaiting ownership review by Forly.";
        claimForm.hidden = true;
        codeForm.hidden = true;
      })
      .catch(error)
      .then(function () {
        button.disabled = false;
      });
  });
})();
