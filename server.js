require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// DB 접속 pool 설정 (환경변수 활용 - 보안 요구사항 충족)
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'plandosee',
  waitForConnections: true,
  connectionLimit: 10
});

// KST 오늘 날짜 (YYYY-MM-DD)
const getKSTDateString = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().split('T')[0];
};

// 1. 전체 데이터 JSON 파일 다운로드 API (T06-C36)
app.get('/api/export', async (req, res) => {
  try {
    const [plans] = await pool.query('SELECT * FROM plans');
    const [todos] = await pool.query('SELECT * FROM todos');
    const [logs] = await pool.query('SELECT * FROM execution_logs');
    const [reviews] = await pool.query('SELECT * FROM reviews');

    const exportData = {
      exported_at: new Date().toISOString(),
      plans,
      todos,
      execution_logs: logs,
      reviews
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="plandosee_backup.json"');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. TODO 목록 (검색, 필터, 지연/막힘 유형, 정렬) API
app.get('/api/todos', async (req, res) => {
  const { plan_id = 1, search, status, filter_type, sort_by = 'due_date' } = req.query;
  const kstToday = getKSTDateString();

  let query = `
    SELECT t.*, el.actual_hours, el.obstacle_reason
    FROM todos t
    LEFT JOIN execution_logs el ON t.id = el.todo_id
    WHERE t.plan_id = ?
  `;
  const params = [plan_id];

  if (search) {
    query += ' AND (t.content LIKE ? OR t.tags LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status && status !== 'ALL') {
    query += ' AND t.status = ?';
    params.push(status);
  }
  if (filter_type === 'DELAYED') {
    query += ' AND t.status != "COMPLETED" AND t.due_date < ?';
    params.push(kstToday);
  } else if (filter_type === 'BLOCKED') {
    query += ' AND el.obstacle_reason IS NOT NULL AND TRIM(el.obstacle_reason) != ""';
  }

  const allowedSortCols = ['due_date', 'priority', 'estimated_hours'];
  const orderCol = allowedSortCols.includes(sort_by) ? sort_by : 'due_date';
  query += ` ORDER BY t.${orderCol} ASC`;

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 할 일 완료 처리 및 실행 로그 기록 API (트랜잭션)
app.post('/api/todos/:id/complete', async (req, res) => {
  const todoId = req.params.id;
  const { actual_hours, obstacle_reason } = req.body;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.query('UPDATE todos SET status = "COMPLETED" WHERE id = ?', [todoId]);
    await conn.query(
      `INSERT INTO execution_logs (todo_id, start_time, end_time, actual_hours, obstacle_reason) 
       VALUES (?, NOW(), NOW(), ?, ?)`,
      [todoId, actual_hours || 0, obstacle_reason || null]
    );

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 4. SEE 돌아보기 집계 요약 API (T06-C28 ~ C32)
app.get('/api/plans/:id/review-summary', async (req, res) => {
  const planId = req.params.id;
  const kstToday = getKSTDateString();

  const query = `
    SELECT 
      COUNT(t.id) AS total_plans,
      COUNT(CASE WHEN t.status = 'COMPLETED' THEN 1 END) AS completed_count,
      COUNT(CASE WHEN t.status != 'COMPLETED' AND t.due_date < ? THEN 1 END) AS delayed_count,
      COUNT(DISTINCT CASE WHEN el.obstacle_reason IS NOT NULL AND TRIM(el.obstacle_reason) != '' THEN t.id END) AS blocked_count,
      COALESCE(SUM(t.estimated_hours), 0) AS total_estimated_hours,
      COALESCE(SUM(el.actual_hours), 0) AS total_actual_hours,
      (COALESCE(SUM(el.actual_hours), 0) - COALESCE(SUM(t.estimated_hours), 0)) AS time_difference
    FROM todos t
    LEFT JOIN execution_logs el ON t.id = el.todo_id
    WHERE t.plan_id = ?
  `;

  try {
    const [rows] = await pool.query(query, [kstToday, planId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));