// 이메일 + 비밀번호 로그인과 JWT 발급/검증.
// 토큰은 Authorization: Bearer <token> 헤더로 주고받는다.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;
const MIN_SECRET_LENGTH = 32;

// 비밀키가 약하면 토큰을 위조할 수 있으므로, 없는 채로는 인증을 처리하지 않는다
function getSecret() {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    const err = new Error('서버에 JWT_SECRET 이 설정되지 않았습니다.');
    err.status = 503;
    throw err;
  }
  return secret;
}

// 서버가 켜질 때 한 번 확인해 주기 위한 용도 (없으면 안내 문구만 돌려준다)
function secretProblem() {
  try {
    getSecret();
    return null;
  } catch (_err) {
    return `JWT_SECRET 이 없거나 너무 짧습니다(${MIN_SECRET_LENGTH}자 이상 필요). .env 에 추가해 주세요.\n    예) node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
  }
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);
const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

// sub 에 사용자 id 를 담는다 (JWT 표준 클레임)
const signToken = (user) =>
  jwt.sign({ sub: String(user.id), email: user.email }, getSecret(), { expiresIn: TOKEN_TTL });

// Authorization 헤더에서 Bearer 토큰만 꺼낸다
function readBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

// 토큰이 유효하면 req.userId 를 채우고, 아니면 401 로 끊는다
function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, getSecret());
  } catch (err) {
    if (err.status === 503) {
      return res.status(503).json({ success: false, message: err.message });
    }
    const expired = err instanceof jwt.TokenExpiredError;
    return res.status(401).json({
      success: false,
      message: expired ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : '로그인 정보가 올바르지 않습니다.',
    });
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ success: false, message: '로그인 정보가 올바르지 않습니다.' });
  }
  req.userId = userId;
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth, secretProblem, TOKEN_TTL };
