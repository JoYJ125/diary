require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase PostgreSQL 연결 설정
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// DB 연결 테스트
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Supabase DB 연결 실패:', err.stack);
  } else {
    console.log('✅ Supabase PostgreSQL DB 연결 성공!');
    release();
  }
});

// KST 오늘 날짜 (YYYY-MM-DD)
const getKSTDateString = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().split('T')[0];
};

// 1. 할 일 신규 등록 API (DB에 새 행 저장 - 수정 및 디버깅 로그 추가)
app.post('/api/todos', async (req, res) => {
  const { plan_id = 1, content, due_date, priority = 'MEDIUM', tags = '', estimated_hours = 0 } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: '할 일 내용을 입력해주세요.' });
  }

  try {
    const query = `
      INSERT INTO todos (plan_id, content, status, due_date, priority, tags, estimated_hours)
      VALUES ($1, $2, 'IN_PROGRESS', $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      Number(plan_id),
      content.trim(),
      due_date ? due_date : null,
      priority,
      tags || '',
      Number(estimated_hours) || 0
    ];

    const { rows } = await pool.query(query, values);
    console.log('✅ 새 할 일 DB 저장 성공:', rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('❌ 할 일 추가 실패 (DB 에러):', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. TODO 목록 (검색, 필터, 지연/막힘, 정렬) API
app.get('/api/todos', async (req, res) => {
  const { plan_id = 1, search, status, filter_type, sort_by = 'due_date' } = req.query;
  const kstToday = getKSTDateString();

  let query = `
    SELECT t.*, el.actual_hours, el.obstacle_reason
    FROM todos t
    LEFT JOIN execution_logs el ON t.id = el.todo_id
    WHERE t.plan_id = $1
  `;
  const params = [plan_id];
  let paramIdx = 2;

  if (search) {
    query += ` AND (t.content ILIKE $${paramIdx} OR t.tags ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }
  if (status && status !== 'ALL') {
    query += ` AND t.status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }
  if (filter_type === 'DELAYED') {
    query += ` AND t.status != 'COMPLETED' AND t.due_date < $${paramIdx}`;
    params.push(kstToday);
    paramIdx++;
  } else if (filter_type === 'BLOCKED') {
    query += ` AND el.obstacle_reason IS NOT NULL AND TRIM(el.obstacle_reason) != ''`;
  }

  const allowedSortCols = ['due_date', 'priority', 'estimated_hours'];
  const orderCol = allowedSortCols.includes(sort_by) ? sort_by : 'due_date';
  query += ` ORDER BY t.${orderCol} ASC`;

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ 할 일 목록 조회 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. 할 일 완료 처리 API (트랜잭션)
app.post('/api/todos/:id/complete', async (req, res) => {
  const todoId = req.params.id;
  const { actual_hours, obstacle_reason } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query("UPDATE todos SET status = 'COMPLETED' WHERE id = $1", [todoId]);
    await client.query(
      `INSERT INTO execution_logs (todo_id, start_time, end_time, actual_hours, obstacle_reason) 
       VALUES ($1, NOW(), NOW(), $2, $3)`,
      [todoId, Number(actual_hours) || 0, obstacle_reason || null]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ 할 일 완료 처리 오류:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. SEE 돌아보기 집계 요약 API
app.get('/api/plans/:id/review-summary', async (req, res) => {
  const planId = req.params.id;
  const kstToday = getKSTDateString();

  const query = `
    SELECT 
      COUNT(t.id)::int AS total_plans,
      COUNT(CASE WHEN t.status = 'COMPLETED' THEN 1 END)::int AS completed_count,
      COUNT(CASE WHEN t.status != 'COMPLETED' AND t.due_date < $1 THEN 1 END)::int AS delayed_count,
      COUNT(DISTINCT CASE WHEN el.obstacle_reason IS NOT NULL AND TRIM(el.obstacle_reason) != '' THEN t.id END)::int AS blocked_count,
      COALESCE(SUM(t.estimated_hours), 0)::int AS total_estimated_hours,
      COALESCE(SUM(el.actual_hours), 0)::int AS total_actual_hours,
      (COALESCE(SUM(el.actual_hours), 0) - COALESCE(SUM(t.estimated_hours), 0))::int AS time_difference
    FROM todos t
    LEFT JOIN execution_logs el ON t.id = el.todo_id
    WHERE t.plan_id = $2
  `;

  try {
    const { rows } = await pool.query(query, [kstToday, planId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ 돌아보기 집계 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. 전체 데이터 JSON 파일 내보내기 API
app.get('/api/export', async (req, res) => {
  try {
    const plans = await pool.query('SELECT * FROM plans');
    const todos = await pool.query('SELECT * FROM todos');
    const logs = await pool.query('SELECT * FROM execution_logs');
    const reviews = await pool.query('SELECT * FROM reviews');

    const exportData = {
      exported_at: new Date().toISOString(),
      plans: plans.rows,
      todos: todos.rows,
      execution_logs: logs.rows,
      reviews: reviews.rows
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="plandosee_backup.json"');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`));
