function isValidNewResidentPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 1024
  );
}

module.exports = { isValidNewResidentPassword };
